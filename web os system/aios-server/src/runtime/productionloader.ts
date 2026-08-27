// Production FlowArtifact loader for Langflow Production Runtime.
//
// Runtime ≠ Engine: LANGFLOW is RuntimeKind only — never an Engine enum value.
// Fail-closed: only active PRODUCTION deployments whose linked artifact is
// VALIDATED and digest-verified may load. Any failure rejects (or skips in list).
// Read-only: zero DB writes. Secrets in error messages always go through redactSecrets.
import type { FlowArtifact, RuntimeDeployment } from '@prisma/client';
import { prisma } from '../lib/db.js';
import {
  FlowArtifactError,
  verifyArtifactDigest,
} from '../lib/flowartifact.js';
import { redactSecrets } from '../memory/redactor.js';

export type ProductionLoadErrorCode =
  | 'NOT_FOUND'
  | 'NOT_ACTIVE'
  | 'WRONG_ENVIRONMENT'
  | 'NOT_VALIDATED'
  | 'DIGEST_MISMATCH';

export class ProductionLoadError extends Error {
  readonly code: ProductionLoadErrorCode;

  constructor(code: ProductionLoadErrorCode, message: string) {
    super(redactSecrets(message));
    this.name = 'ProductionLoadError';
    this.code = code;
  }
}

export type LoadProductionResult = {
  deployment: RuntimeDeployment;
  artifact: FlowArtifact;
};

export type ListLoadableResult = {
  loadable: LoadProductionResult[];
  skipped: Array<{ deploymentId: string; code: ProductionLoadErrorCode }>;
};

/**
 * Fail-closed sequential checks (read-only, zero DB writes):
 * 1. deployment exists → NOT_FOUND
 * 2. environment === PRODUCTION → WRONG_ENVIRONMENT
 * 3. active === true → NOT_ACTIVE
 * 4. artifact exists → NOT_FOUND; status === VALIDATED → NOT_VALIDATED
 * 5. verifyArtifactDigest → DIGEST_MISMATCH
 */
export async function loadProductionArtifact(
  deploymentId: string,
): Promise<LoadProductionResult> {
  if (typeof deploymentId !== 'string' || !deploymentId.trim()) {
    throw new ProductionLoadError('NOT_FOUND', 'RuntimeDeployment not found');
  }

  const deployment = await prisma.runtimeDeployment.findUnique({
    where: { id: deploymentId },
    include: { artifact: true },
  });

  if (!deployment) {
    throw new ProductionLoadError(
      'NOT_FOUND',
      `RuntimeDeployment not found: ${deploymentId}`,
    );
  }

  if (deployment.environment !== 'PRODUCTION') {
    throw new ProductionLoadError(
      'WRONG_ENVIRONMENT',
      `deployment ${deploymentId} environment is ${deployment.environment}, expected PRODUCTION`,
    );
  }

  if (deployment.active !== true) {
    throw new ProductionLoadError(
      'NOT_ACTIVE',
      `deployment ${deploymentId} is not active`,
    );
  }

  const artifact = deployment.artifact;
  if (!artifact) {
    throw new ProductionLoadError(
      'NOT_FOUND',
      `FlowArtifact not found for deployment ${deploymentId}`,
    );
  }

  if (artifact.status !== 'VALIDATED') {
    throw new ProductionLoadError(
      'NOT_VALIDATED',
      `FlowArtifact ${artifact.id} status is ${artifact.status}, expected VALIDATED`,
    );
  }

  try {
    verifyArtifactDigest(artifact.artifactJson, artifact.digest);
  } catch (e) {
    if (e instanceof FlowArtifactError && e.code === 'DIGEST_MISMATCH') {
      throw new ProductionLoadError(
        'DIGEST_MISMATCH',
        e.message || `digest mismatch for FlowArtifact ${artifact.id}`,
      );
    }
    throw new ProductionLoadError(
      'DIGEST_MISMATCH',
      e instanceof Error
        ? e.message
        : `digest mismatch for FlowArtifact ${artifact.id}`,
    );
  }

  // Strip relation from returned deployment shape (RuntimeDeployment only)
  const { artifact: _omit, ...deploymentRow } = deployment;
  return {
    deployment: deploymentRow as RuntimeDeployment,
    artifact,
  };
}

/**
 * List all active PRODUCTION deployments that pass the same fail-closed checks.
 * Failed rows go to skipped (never loadable). This function does not throw for
 * per-row validation failures.
 */
export async function listLoadableProductionArtifacts(): Promise<ListLoadableResult> {
  const rows = await prisma.runtimeDeployment.findMany({
    where: {
      active: true,
      environment: 'PRODUCTION',
    },
    include: { artifact: true },
  });

  const loadable: LoadProductionResult[] = [];
  const skipped: Array<{ deploymentId: string; code: ProductionLoadErrorCode }> =
    [];

  for (const row of rows) {
    try {
      // Reuse the same sequential validation via the public loader path
      // (re-fetch is intentional: keeps a single fail-closed code path).
      const result = await loadProductionArtifact(row.id);
      loadable.push(result);
    } catch (e) {
      const code =
        e instanceof ProductionLoadError
          ? e.code
          : (('NOT_FOUND' as ProductionLoadErrorCode));
      skipped.push({ deploymentId: row.id, code });
    }
  }

  return { loadable, skipped };
}
