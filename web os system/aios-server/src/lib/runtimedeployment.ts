// Fail-closed FDE Runtime Deployment gate + rollback (Phase 3 Ticket 06).
// Style aligned with skillpromote.ts: all gates pass before a single transaction write.
// Runtime ≠ Engine: LANGFLOW is RuntimeKind only.
import { ulid } from 'ulid';
import type {
  DeploymentChannel,
  DeploymentEnvironment,
  Engine,
  RuntimeDeployment,
  RuntimeKind,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { ApiError, errors } from './http.js';
import { audit } from './audit.js';
import { assertWriteEnabled } from './stopwrite.js';
import {
  FlowArtifactError,
  computeFlowArtifactDigest,
  getVerifiedFlowArtifact,
} from './flowartifact.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { redactSecrets } from '../memory/redactor.js';
import type { RuntimeAdapter } from '../runtime/adapter.js';
import { NativeAdapter } from '../runtime/native.js';
import { LangflowAdapter } from '../runtime/langflow.js';
import {
  GRAPH_LANGFLOW_TEMPLATE_ID,
  GRAPH_SOURCE_TEMPLATE_ID,
  isLangflowNativeFlowData,
} from '../graph/types.js';

export const ENGINE_MODEL_FAMILY: Record<Engine, string> = {
  CLAUDE_CODE: 'anthropic',
  CODEX: 'openai',
  GROK: 'xai',
};

const ENV_WHITELIST = new Set<string>(['SANDBOX', 'STAGING', 'PRODUCTION']);
const CHANNEL_WHITELIST = new Set<string>(['CANARY', 'STABLE']);
const ARTIFACT_STATUS_WHITELIST = new Set<string>([
  'COMPILED',
  'VALIDATED',
  'REJECTED',
  'SUPERSEDED',
]);
const RUNTIME_KIND_WHITELIST = new Set<string>(['NATIVE', 'LANGFLOW']);

export type RuntimeDeploymentDeps = {
  adapter?: RuntimeAdapter;
};

function assertFde(actorRole: string): void {
  if (actorRole !== 'OWNER' && actorRole !== 'TRAINER') {
    throw errors.forbidden('需要訓練權限（OWNER 或 TRAINER）才能部署/回滾 Runtime');
  }
}

function mapFlowArtifactError(e: unknown): never {
  if (e instanceof FlowArtifactError) {
    if (e.code === 'DIGEST_MISMATCH') {
      throw errors.conflict(e.message.includes('digest') ? e.message : `digest mismatch: ${e.message}`);
    }
    if (e.code === 'NOT_FOUND') {
      throw errors.notFound(e.message);
    }
    throw errors.badRequest(e.message);
  }
  throw e;
}

async function loadVerifiedArtifact(artifactId: string) {
  try {
    return await getVerifiedFlowArtifact(artifactId);
  } catch (e) {
    mapFlowArtifactError(e);
  }
}

/**
 * Fail-closed graph engineering deployment guards (Review 2).
 * - graph-engineering-v2-source is authoring-only (never validate/activate as Runtime).
 * - graph-engineering-v2-langflow must be LANGFLOW + native genericNode flow.data.
 * Independent of artifact.status (covers stale VALIDATED rows).
 */
export function assertGraphRuntimeArtifactAllowed(artifact: {
  template: string;
  runtimeKind: string;
  artifactJson: unknown;
}): void {
  if (artifact.template === GRAPH_SOURCE_TEMPLATE_ID) {
    throw new ApiError(
      409,
      'GRAPH_SOURCE_AUTHORING_ONLY',
      'GraphSpec source artifact is authoring-only and cannot be validated or deployed as a Runtime artifact',
      { template: GRAPH_SOURCE_TEMPLATE_ID },
    );
  }

  if (artifact.template === GRAPH_LANGFLOW_TEMPLATE_ID) {
    if (artifact.runtimeKind !== 'LANGFLOW') {
      throw new ApiError(
        409,
        'GRAPH_LANGFLOW_SHAPE_INVALID',
        `graph-engineering langflow artifact requires runtimeKind=LANGFLOW (got ${artifact.runtimeKind})`,
        { template: GRAPH_LANGFLOW_TEMPLATE_ID },
      );
    }
    if (!isLangflowNativeFlowData(artifact.artifactJson)) {
      throw new ApiError(
        409,
        'GRAPH_LANGFLOW_SHAPE_INVALID',
        'graph-engineering langflow artifact must be native flow.data (genericNode nodes + edges + viewport)',
        { template: GRAPH_LANGFLOW_TEMPLATE_ID },
      );
    }
  }
}

/**
 * Ticket 25 — LANGFLOW network adapter resolution requires an explicit
 * DeploymentEnvironment. There is no cross-env fallback and no global
 * Production default. Missing/blank URL or key rejects before network I/O.
 *
 * NATIVE does not require a Langflow environment.
 */
const LANGFLOW_ENV_CONFIG: Record<
  DeploymentEnvironment,
  { urlEnv: string; keyEnv: string; label: string }
> = {
  SANDBOX: {
    urlEnv: 'AIOS_LANGFLOW_SANDBOX_URL',
    keyEnv: 'AIOS_LANGFLOW_SANDBOX_API_KEY',
    label: 'SANDBOX',
  },
  STAGING: {
    urlEnv: 'AIOS_LANGFLOW_STAGING_URL',
    keyEnv: 'AIOS_LANGFLOW_STAGING_API_KEY',
    label: 'STAGING',
  },
  PRODUCTION: {
    urlEnv: 'AIOS_LANGFLOW_RUNTIME_URL',
    keyEnv: 'AIOS_LANGFLOW_PRODUCTION_API_KEY',
    label: 'PRODUCTION',
  },
};

export function resolveRuntimeAdapter(
  kind: RuntimeKind,
  environment?: DeploymentEnvironment | string | null,
): RuntimeAdapter {
  if (kind === 'NATIVE') {
    return new NativeAdapter();
  }
  if (kind === 'LANGFLOW') {
    if (typeof environment !== 'string' || !ENV_WHITELIST.has(environment)) {
      throw errors.conflict(
        'LANGFLOW runtime 需要明確 environment（SANDBOX|STAGING|PRODUCTION），禁止跨環境回退',
      );
    }
    const env = environment as DeploymentEnvironment;
    const cfg = LANGFLOW_ENV_CONFIG[env];
    // Fail-closed: named URL + control-plane API key for this environment only.
    // Key is Langflow x-api-key credential (not a provider key); never log the value.
    const baseUrl = process.env[cfg.urlEnv];
    if (!baseUrl || baseUrl.trim() === '') {
      throw errors.conflict(
        `LANGFLOW ${cfg.label} URL 未設定（${cfg.urlEnv}），fail-closed 拒絕`,
      );
    }
    const apiKey = process.env[cfg.keyEnv];
    if (!apiKey || apiKey.trim() === '') {
      throw errors.conflict(
        `LANGFLOW ${cfg.label} API key 未設定（${cfg.keyEnv}），fail-closed 拒絕`,
      );
    }
    return new LangflowAdapter({ baseUrl, apiKey });
  }
  throw errors.badRequest(`unsupported runtimeKind: ${String(kind)}`);
}

/**
 * Local structural validation adapter — no remote URL/credential required.
 * LangflowAdapter.validateArtifact is pure/local; placeholder construct values
 * are never used for network I/O by validateArtifactForRuntime.
 */
export function resolveLocalValidationAdapter(kind: RuntimeKind): RuntimeAdapter {
  if (kind === 'NATIVE') {
    return new NativeAdapter();
  }
  if (kind === 'LANGFLOW') {
    return new LangflowAdapter({
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'local-validation-only',
    });
  }
  throw errors.badRequest(`unsupported runtimeKind: ${String(kind)}`);
}

function parseEnvironment(v: unknown): DeploymentEnvironment {
  if (typeof v !== 'string' || !ENV_WHITELIST.has(v)) {
    throw errors.badRequest(`非法 environment: 必須為 SANDBOX|STAGING|PRODUCTION，收到 ${String(v)}`);
  }
  return v as DeploymentEnvironment;
}

function parseChannel(v: unknown): DeploymentChannel {
  if (typeof v !== 'string' || !CHANNEL_WHITELIST.has(v)) {
    throw errors.badRequest(`非法 channel: 必須為 CANARY|STABLE，收到 ${String(v)}`);
  }
  return v as DeploymentChannel;
}

export type DeploymentSummary = {
  id: string;
  artifactId: string;
  skillId: string;
  environment: DeploymentEnvironment;
  channel: DeploymentChannel;
  runtimeBinding: unknown;
  deployedBy: string | null;
  active: boolean;
  activatedAt: Date;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  reused?: boolean;
  digest?: string;
  artifactStatus?: string;
  executionModelFamily?: string;
  verificationModelFamily?: string;
  evalRunId?: string;
};

function toSummary(
  row: RuntimeDeployment,
  extra?: Partial<DeploymentSummary>,
): DeploymentSummary {
  return {
    id: row.id,
    artifactId: row.artifactId,
    skillId: row.skillId,
    environment: row.environment,
    channel: row.channel,
    runtimeBinding: row.runtimeBinding,
    deployedBy: row.deployedBy,
    active: row.active,
    activatedAt: row.activatedAt,
    deactivatedAt: row.deactivatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...extra,
  };
}

/**
 * Validate artifact via adapter; COMPILED → VALIDATED (idempotent if already VALIDATED).
 */
export async function validateArtifactForRuntime(
  args: { artifactId: string; actorId: string; actorRole: string },
  deps?: RuntimeDeploymentDeps,
): Promise<{ id: string; status: string; digest: string; runtimeKind: RuntimeKind }> {
  assertWriteEnabled('langflowRuntime');
  assertFde(args.actorRole);

  const artifact = await loadVerifiedArtifact(args.artifactId);

  // Graph Engineering: authoring-only source + compiled shape (before adapter/status side effects).
  assertGraphRuntimeArtifactAllowed(artifact);

  if (artifact.status !== 'COMPILED' && artifact.status !== 'VALIDATED') {
    throw errors.conflict(
      `FlowArtifact 狀態必須為 COMPILED 或 VALIDATED，目前為 ${artifact.status}`,
    );
  }

  // Local-only: must not require Langflow remote credentials (Ticket 25).
  const adapter = deps?.adapter ?? resolveLocalValidationAdapter(artifact.runtimeKind);
  const validation = await adapter.validateArtifact({
    artifactId: artifact.id,
    artifactJson: artifact.artifactJson,
    digest: artifact.digest,
  });
  if (!validation.valid) {
    const detail = redactSecrets((validation.errors ?? []).join('; ') || 'validation failed');
    throw errors.conflict(`adapter 驗證失敗: ${detail}`);
  }

  if (artifact.status === 'COMPILED') {
    await prisma.flowArtifact.update({
      where: { id: artifact.id },
      data: { status: 'VALIDATED' },
    });
  }

  await audit(args.actorId, 'runtime.artifact.validate', 'FlowArtifact', artifact.id, {
    digest: artifact.digest,
    runtimeKind: artifact.runtimeKind,
  });

  return {
    id: artifact.id,
    status: 'VALIDATED',
    digest: artifact.digest,
    runtimeKind: artifact.runtimeKind,
  };
}

/**
 * Eight-gate fail-closed activate. Zero DB writes unless all gates pass.
 */
export async function activateDeployment(
  args: {
    artifactId: string;
    environment: string;
    channel: string;
    actorId: string;
    actorRole: string;
  },
  deps?: RuntimeDeploymentDeps,
): Promise<DeploymentSummary> {
  assertWriteEnabled('langflowRuntime');
  // 1. FDE
  assertFde(args.actorRole);

  // 2. enum whitelist
  const environment = parseEnvironment(args.environment);
  const channel = parseChannel(args.channel);

  // 3. verified artifact (digest)
  const artifact = await loadVerifiedArtifact(args.artifactId);

  // 3b. Graph Engineering authoring-only / shape guards (independent of status).
  assertGraphRuntimeArtifactAllowed(artifact);

  // 4. must be VALIDATED
  if (artifact.status !== 'VALIDATED') {
    throw errors.conflict(
      `FlowArtifact 必須已 VALIDATED 才能啟用，目前為 ${artifact.status}`,
    );
  }

  // 5. skillVersion + skill CONFIRMED
  if (!artifact.skillVersionId) {
    throw errors.conflict('FlowArtifact 缺少 skillVersionId，拒絕啟用');
  }
  const skillVersion = await prisma.skillVersion.findUnique({
    where: { id: artifact.skillVersionId },
  });
  if (!skillVersion) {
    throw errors.conflict(`SkillVersion 不存在: ${artifact.skillVersionId}`);
  }
  const skill = await prisma.skill.findFirst({
    where: { id: skillVersion.skillId, deletedAt: null },
  });
  if (!skill) {
    throw errors.notFound('Skill not found');
  }
  if (skill.reviewStatus !== 'CONFIRMED') {
    throw errors.conflict('技能尚未經 FDE 確認，不可啟用部署（永不在此代確認）');
  }
  const skillId = skill.id;

  // 6. PASSED EvalRun + no unresolved highRisk
  const passedRun = await prisma.evalRun.findFirst({
    where: {
      skillId,
      candidateVersionId: artifact.skillVersionId,
      status: 'PASSED',
    },
    orderBy: { startedAt: 'desc' },
  });
  if (!passedRun) {
    throw errors.conflict('沒有通過的評測執行，拒絕啟用（fail-closed）');
  }
  const openHighRisk = await prisma.evalResult.findFirst({
    where: {
      highRisk: true,
      resolved: false,
      run: {
        skillId,
        candidateVersionId: artifact.skillVersionId,
      },
    },
  });
  if (openHighRisk) {
    throw errors.conflict('存在未解的高風險評測失敗，拒絕啟用');
  }

  // 7. model family cross-check (server truth)
  const executionModelFamily = ENGINE_MODEL_FAMILY[passedRun.executeEngine];
  const verificationModelFamily = ENGINE_MODEL_FAMILY[passedRun.verifyEngine];
  if (executionModelFamily === verificationModelFamily) {
    throw errors.conflict('執行與驗證 model family 相同，拒絕啟用');
  }

  // 8. adapter validation (local — no remote credential required)
  const validationAdapter =
    deps?.adapter ?? resolveLocalValidationAdapter(artifact.runtimeKind);
  const validation = await validationAdapter.validateArtifact({
    artifactId: artifact.id,
    artifactJson: artifact.artifactJson,
    digest: artifact.digest,
  });
  if (!validation.valid) {
    const detail = redactSecrets((validation.errors ?? []).join('; ') || 'validation failed');
    throw errors.conflict(`adapter 驗證失敗: ${detail}`);
  }

  // Idempotent: already active for this artifact+env+channel
  const existing = await prisma.runtimeDeployment.findUnique({
    where: {
      artifactId_environment_channel: {
        artifactId: artifact.id,
        environment,
        channel,
      },
    },
  });
  if (existing?.active) {
    await audit(args.actorId, 'runtime.deployment.activate', 'RuntimeDeployment', existing.id, {
      artifactId: artifact.id,
      digest: artifact.digest,
      environment,
      channel,
      reused: true,
      executionModelFamily,
      verificationModelFamily,
      evalRunId: passedRun.id,
    });
    return toSummary(existing, {
      reused: true,
      digest: artifact.digest,
      artifactStatus: artifact.status,
      executionModelFamily,
      verificationModelFamily,
      evalRunId: passedRun.id,
    });
  }

  // Network deploy: explicit environment (Ticket 25 — no cross-env fallback).
  // Prefer injected adapter (tests); otherwise resolve named env credentials.
  const deployAdapter =
    deps?.adapter ??
    (artifact.runtimeKind === 'LANGFLOW'
      ? resolveRuntimeAdapter('LANGFLOW', environment)
      : resolveRuntimeAdapter('NATIVE'));
  // deploy outside transaction (opaque binding); DB write is atomic
  const rawBinding = await deployAdapter.deployArtifact({
    artifactId: artifact.id,
    artifactJson: artifact.artifactJson,
    digest: artifact.digest,
    environment,
    channel,
  });
  const runtimeBinding = deepRedactSecrets(rawBinding) as unknown as Prisma.InputJsonValue;

  const row = await prisma.$transaction(async (tx) => {
    // Deactivate current active pointer for skill+env+channel
    await tx.runtimeDeployment.updateMany({
      where: {
        skillId,
        environment,
        channel,
        active: true,
      },
      data: {
        active: false,
        deactivatedAt: new Date(),
      },
    });

    if (existing && !existing.active) {
      return tx.runtimeDeployment.update({
        where: { id: existing.id },
        data: {
          active: true,
          deactivatedAt: null,
          runtimeBinding,
          deployedBy: args.actorId,
          activatedAt: new Date(),
        },
      });
    }

    return tx.runtimeDeployment.create({
      data: {
        id: ulid(),
        artifactId: artifact.id,
        skillId,
        environment,
        channel,
        runtimeBinding,
        deployedBy: args.actorId,
        active: true,
      },
    });
  });

  await audit(args.actorId, 'runtime.deployment.activate', 'RuntimeDeployment', row.id, {
    artifactId: artifact.id,
    digest: artifact.digest,
    environment,
    channel,
    executionModelFamily,
    verificationModelFamily,
    evalRunId: passedRun.id,
  });

  return toSummary(row, {
    reused: false,
    digest: artifact.digest,
    artifactStatus: artifact.status,
    executionModelFamily,
    verificationModelFamily,
    evalRunId: passedRun.id,
  });
}

/**
 * Rollback: switch active pointer to an existing deployment. Never deletes rows.
 */
export async function rollbackDeployment(args: {
  deploymentId: string;
  actorId: string;
  actorRole: string;
}): Promise<DeploymentSummary> {
  assertWriteEnabled('langflowRuntime');
  assertFde(args.actorRole);

  const target = await prisma.runtimeDeployment.findUnique({
    where: { id: args.deploymentId },
  });
  if (!target) {
    throw errors.notFound('RuntimeDeployment not found');
  }

  // Digest must still verify for the target artifact
  await loadVerifiedArtifact(target.artifactId);

  if (target.active) {
    return toSummary(target, { reused: true });
  }

  // Capture current active for audit (fromDeploymentId = the one we leave)
  const currentActive = await prisma.runtimeDeployment.findFirst({
    where: {
      skillId: target.skillId,
      environment: target.environment,
      channel: target.channel,
      active: true,
    },
  });

  const row = await prisma.$transaction(async (tx) => {
    await tx.runtimeDeployment.updateMany({
      where: {
        skillId: target.skillId,
        environment: target.environment,
        channel: target.channel,
        active: true,
      },
      data: {
        active: false,
        deactivatedAt: new Date(),
      },
    });
    return tx.runtimeDeployment.update({
      where: { id: target.id },
      data: {
        active: true,
        deactivatedAt: null,
        activatedAt: new Date(),
      },
    });
  });

  await audit(args.actorId, 'runtime.deployment.rollback', 'RuntimeDeployment', row.id, {
    fromDeploymentId: currentActive?.id ?? null,
    artifactId: row.artifactId,
    environment: row.environment,
    channel: row.channel,
  });

  return toSummary(row);
}

export async function listDeployments(filter: {
  skillId?: string;
  environment?: string;
  channel?: string;
  active?: boolean;
}): Promise<DeploymentSummary[]> {
  const where: Prisma.RuntimeDeploymentWhereInput = {};
  if (filter.skillId) where.skillId = filter.skillId;
  if (filter.environment) where.environment = parseEnvironment(filter.environment);
  if (filter.channel) where.channel = parseChannel(filter.channel);
  if (filter.active !== undefined) where.active = filter.active;

  const rows = await prisma.runtimeDeployment.findMany({
    where,
    orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
    include: {
      artifact: {
        select: { digest: true, status: true, runtimeKind: true },
      },
    },
  });

  return rows.map((r) =>
    toSummary(r, {
      digest: r.artifact.digest,
      artifactStatus: r.artifact.status,
    }),
  );
}

// ── Ticket 15: Admin Runtime Governance (read-only projections + kill switch) ─

export type RuntimeArtifactSkillInfo = {
  id: string;
  name: string;
  version: number;
  schemaVersion: string | null;
};

export type RuntimeArtifactRow = {
  id: string;
  skillVersionId: string | null;
  workflowId: string | null;
  runtimeKind: RuntimeKind;
  template: string;
  templateVersion: string | null;
  compilerVersion: string;
  digest: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  digestOk: boolean;
  skill: RuntimeArtifactSkillInfo | null;
  activeDeployments: number;
};

export type ReadinessCheck = { key: string; ok: boolean; reason: string };
export type ReadinessReport = { canActivate: boolean; checks: ReadinessCheck[] };

export type RuntimeArtifactDetail = {
  artifact: RuntimeArtifactRow & {
    artifactJson: unknown;
    metadata: unknown;
  };
  skillIr: { schemaVersion: string | null; specJson: unknown } | null;
  readiness: ReadinessReport;
  deployments: DeploymentSummary[];
};

/** Fail-safe digest check for display only — never throws. */
function safeDigestOk(artifactJson: unknown, digest: string): boolean {
  try {
    return computeFlowArtifactDigest(artifactJson) === digest;
  } catch {
    return false;
  }
}

function parseArtifactStatusFilter(v: string): string {
  if (!ARTIFACT_STATUS_WHITELIST.has(v)) {
    throw errors.badRequest(
      `非法 status: 必須為 COMPILED|VALIDATED|REJECTED|SUPERSEDED，收到 ${String(v)}`,
    );
  }
  return v;
}

function parseRuntimeKindFilter(v: string): RuntimeKind {
  if (!RUNTIME_KIND_WHITELIST.has(v)) {
    throw errors.badRequest(
      `非法 runtimeKind: 必須為 NATIVE|LANGFLOW，收到 ${String(v)}`,
    );
  }
  return v as RuntimeKind;
}

/**
 * List FlowArtifacts for FDE admin UI.
 * digestOk is fail-safe display only (drift → false, never throws).
 */
export async function listRuntimeArtifacts(filter: {
  skillId?: string;
  status?: string;
  runtimeKind?: string;
}): Promise<RuntimeArtifactRow[]> {
  const where: Prisma.FlowArtifactWhereInput = {};
  if (filter.skillId) {
    where.skillVersion = { skillId: filter.skillId };
  }
  if (filter.status) {
    where.status = parseArtifactStatusFilter(filter.status) as Prisma.EnumFlowArtifactStatusFilter;
  }
  if (filter.runtimeKind) {
    where.runtimeKind = parseRuntimeKindFilter(filter.runtimeKind);
  }

  const rows = await prisma.flowArtifact.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      skillVersion: {
        select: {
          id: true,
          skillId: true,
          version: true,
          schemaVersion: true,
        },
      },
      _count: {
        select: {
          deployments: { where: { active: true } },
        },
      },
    },
  });

  const skillIds = [
    ...new Set(
      rows
        .map((r) => r.skillVersion?.skillId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const skills =
    skillIds.length === 0
      ? []
      : await prisma.skill.findMany({
          where: { id: { in: skillIds } },
          select: { id: true, name: true },
        });
  const skillNameById = new Map(skills.map((s) => [s.id, s.name]));

  return rows.map((r) => {
    const sv = r.skillVersion;
    const skill: RuntimeArtifactSkillInfo | null = sv
      ? {
          id: sv.skillId,
          name: skillNameById.get(sv.skillId) ?? sv.skillId,
          version: sv.version,
          schemaVersion: sv.schemaVersion,
        }
      : null;

    return {
      id: r.id,
      skillVersionId: r.skillVersionId,
      workflowId: r.workflowId,
      runtimeKind: r.runtimeKind,
      template: r.template,
      templateVersion: r.templateVersion,
      compilerVersion: r.compilerVersion,
      digest: r.digest,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      digestOk: safeDigestOk(r.artifactJson, r.digest),
      skill,
      activeDeployments: r._count.deployments,
    };
  });
}

/**
 * Read-only readiness projection aligned with activateDeployment gate order.
 * Fail-safe: unknown / missing → ok:false + reason. Never substitutes for activate gates.
 */
export async function getArtifactReadiness(artifactId: string): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];

  const artifact = await prisma.flowArtifact.findUnique({
    where: { id: artifactId },
  });
  if (!artifact) {
    // Caller (detail) handles notFound; for standalone use still return all-false.
    const keys = [
      'digest_ok',
      'status_validated',
      'skill_confirmed',
      'eval_passed',
      'no_unresolved_high_risk',
      'model_family_distinct',
    ] as const;
    return {
      canActivate: false,
      checks: keys.map((key) => ({
        key,
        ok: false,
        reason: '找不到 FlowArtifact',
      })),
    };
  }

  // 0. graph engineering authoring-only / shape (readiness projection)
  let graphGateOk = true;
  let graphGateReason = '非 Graph Engineering 受管制產物（或通過）';
  try {
    assertGraphRuntimeArtifactAllowed(artifact);
  } catch (e) {
    graphGateOk = false;
    graphGateReason =
      e instanceof Error ? e.message : 'Graph Engineering 產物不可部署';
  }
  checks.push({
    key: 'graph_runtime_allowed',
    ok: graphGateOk,
    reason: graphGateReason,
  });

  // 1. digest_ok
  const digestOk = safeDigestOk(artifact.artifactJson, artifact.digest);
  checks.push({
    key: 'digest_ok',
    ok: digestOk,
    reason: digestOk ? '內容雜湊一致' : 'digest 不符：內容遭改動',
  });

  // 2. status_validated
  const statusOk = artifact.status === 'VALIDATED';
  checks.push({
    key: 'status_validated',
    ok: statusOk,
    reason: statusOk
      ? '已通過 Runtime 驗證'
      : `尚未通過 Runtime 驗證（狀態為 ${artifact.status}）`,
  });

  // 3. skill_confirmed
  let skillId: string | null = null;
  let skillVersionId: string | null = artifact.skillVersionId;
  if (!skillVersionId) {
    checks.push({
      key: 'skill_confirmed',
      ok: false,
      reason: 'FlowArtifact 缺少 skillVersionId',
    });
  } else {
    try {
      const skillVersion = await prisma.skillVersion.findUnique({
        where: { id: skillVersionId },
      });
      if (!skillVersion) {
        checks.push({
          key: 'skill_confirmed',
          ok: false,
          reason: `SkillVersion 不存在: ${skillVersionId}`,
        });
      } else {
        skillId = skillVersion.skillId;
        const skill = await prisma.skill.findFirst({
          where: { id: skillVersion.skillId, deletedAt: null },
        });
        if (!skill) {
          checks.push({
            key: 'skill_confirmed',
            ok: false,
            reason: '來源技能不存在或已刪除',
          });
        } else if (skill.reviewStatus !== 'CONFIRMED') {
          checks.push({
            key: 'skill_confirmed',
            ok: false,
            reason: '來源技能尚未經 FDE 確認',
          });
        } else {
          checks.push({
            key: 'skill_confirmed',
            ok: true,
            reason: '來源技能已確認',
          });
        }
      }
    } catch {
      checks.push({
        key: 'skill_confirmed',
        ok: false,
        reason: '無法判定技能確認狀態',
      });
    }
  }

  // 4–6. eval / high-risk / model family
  let passedRun: {
    id: string;
    executeEngine: Engine;
    verifyEngine: Engine;
  } | null = null;

  if (!skillId || !skillVersionId) {
    checks.push({
      key: 'eval_passed',
      ok: false,
      reason: '無法關聯技能版本以查詢評測',
    });
    checks.push({
      key: 'no_unresolved_high_risk',
      ok: false,
      reason: '無法關聯技能版本以查詢高風險',
    });
    checks.push({
      key: 'model_family_distinct',
      ok: false,
      reason: '無通過的評測執行可判定',
    });
  } else {
    try {
      passedRun = await prisma.evalRun.findFirst({
        where: {
          skillId,
          candidateVersionId: skillVersionId,
          status: 'PASSED',
        },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          executeEngine: true,
          verifyEngine: true,
        },
      });
    } catch {
      passedRun = null;
    }

    if (!passedRun) {
      checks.push({
        key: 'eval_passed',
        ok: false,
        reason: '沒有通過的評測執行',
      });
      checks.push({
        key: 'no_unresolved_high_risk',
        ok: false,
        reason: '無通過的評測執行可判定高風險',
      });
      checks.push({
        key: 'model_family_distinct',
        ok: false,
        reason: '無通過的評測執行可判定',
      });
    } else {
      checks.push({
        key: 'eval_passed',
        ok: true,
        reason: '評測已通過',
      });

      try {
        const openHighRisk = await prisma.evalResult.findFirst({
          where: {
            highRisk: true,
            resolved: false,
            run: {
              skillId,
              candidateVersionId: skillVersionId,
            },
          },
        });
        const highRiskOk = !openHighRisk;
        checks.push({
          key: 'no_unresolved_high_risk',
          ok: highRiskOk,
          reason: highRiskOk ? '無未解高風險評測' : '存在未解的高風險評測失敗',
        });
      } catch {
        checks.push({
          key: 'no_unresolved_high_risk',
          ok: false,
          reason: '無法判定高風險狀態',
        });
      }

      try {
        const execFamily = ENGINE_MODEL_FAMILY[passedRun.executeEngine];
        const verifyFamily = ENGINE_MODEL_FAMILY[passedRun.verifyEngine];
        const familyOk = execFamily !== verifyFamily;
        checks.push({
          key: 'model_family_distinct',
          ok: familyOk,
          reason: familyOk
            ? '執行與驗證 model family 已分離'
            : '執行與驗證 model family 相同',
        });
      } catch {
        checks.push({
          key: 'model_family_distinct',
          ok: false,
          reason: '無法判定 model family',
        });
      }
    }
  }

  // Ensure fixed order/keys even if logic paths diverge
  const ORDER = [
    'graph_runtime_allowed',
    'digest_ok',
    'status_validated',
    'skill_confirmed',
    'eval_passed',
    'no_unresolved_high_risk',
    'model_family_distinct',
  ] as const;
  const byKey = new Map(checks.map((c) => [c.key, c]));
  const ordered: ReadinessCheck[] = ORDER.map(
    (key) =>
      byKey.get(key) ?? {
        key,
        ok: false,
        reason: '無法判定',
      },
  );

  return {
    canActivate: ordered.every((c) => c.ok),
    checks: ordered,
  };
}

/**
 * Artifact detail for FDE admin: Skill IR + readiness + deployments.
 */
export async function getRuntimeArtifactDetail(
  id: string,
): Promise<RuntimeArtifactDetail> {
  const row = await prisma.flowArtifact.findUnique({
    where: { id },
    include: {
      skillVersion: {
        select: {
          id: true,
          skillId: true,
          version: true,
          schemaVersion: true,
          specJson: true,
        },
      },
      _count: {
        select: {
          deployments: { where: { active: true } },
        },
      },
    },
  });
  if (!row) {
    throw errors.notFound('FlowArtifact not found');
  }

  let skill: RuntimeArtifactSkillInfo | null = null;
  let skillIr: { schemaVersion: string | null; specJson: unknown } | null = null;
  if (row.skillVersion) {
    const skillRow = await prisma.skill.findFirst({
      where: { id: row.skillVersion.skillId },
      select: { id: true, name: true },
    });
    skill = {
      id: row.skillVersion.skillId,
      name: skillRow?.name ?? row.skillVersion.skillId,
      version: row.skillVersion.version,
      schemaVersion: row.skillVersion.schemaVersion,
    };
    skillIr = {
      schemaVersion: row.skillVersion.schemaVersion,
      specJson: row.skillVersion.specJson,
    };
  }

  const artifact: RuntimeArtifactDetail['artifact'] = {
    id: row.id,
    skillVersionId: row.skillVersionId,
    workflowId: row.workflowId,
    runtimeKind: row.runtimeKind,
    template: row.template,
    templateVersion: row.templateVersion,
    compilerVersion: row.compilerVersion,
    digest: row.digest,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    digestOk: safeDigestOk(row.artifactJson, row.digest),
    skill,
    activeDeployments: row._count.deployments,
    artifactJson: row.artifactJson,
    metadata: row.metadata,
  };

  const readiness = await getArtifactReadiness(id);

  const depRows = await prisma.runtimeDeployment.findMany({
    where: { artifactId: id },
    orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
    include: {
      artifact: {
        select: { digest: true, status: true },
      },
    },
  });
  const deployments = depRows.map((r) =>
    toSummary(r, {
      digest: r.artifact.digest,
      artifactStatus: r.artifact.status,
    }),
  );

  return { artifact, skillIr, readiness, deployments };
}

/**
 * Kill switch: deactivate an active deployment pointer. Never deletes rows.
 * Idempotent if already inactive.
 */
export async function deactivateDeployment(args: {
  deploymentId: string;
  actorId: string;
  actorRole: string;
}): Promise<DeploymentSummary> {
  assertWriteEnabled('langflowRuntime');
  assertFde(args.actorRole);

  const target = await prisma.runtimeDeployment.findUnique({
    where: { id: args.deploymentId },
  });
  if (!target) {
    throw errors.notFound('RuntimeDeployment not found');
  }

  if (!target.active) {
    return toSummary(target, { reused: true });
  }

  const row = await prisma.runtimeDeployment.update({
    where: { id: target.id },
    data: {
      active: false,
      deactivatedAt: new Date(),
    },
  });

  await audit(args.actorId, 'runtime.deployment.deactivate', 'RuntimeDeployment', row.id, {
    artifactId: row.artifactId,
    environment: row.environment,
    channel: row.channel,
    skillId: row.skillId,
  });

  return toSummary(row);
}
