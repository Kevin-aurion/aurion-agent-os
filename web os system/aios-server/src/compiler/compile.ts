// Skill IR → FlowArtifact compiler (template registry only; no free-form generation).
import { createFlowArtifact, computeFlowArtifactDigest } from '../lib/flowartifact.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { redactSecrets } from '../memory/redactor.js';
import { parseSkillIr } from './skillir.js';
import { assertGraphSafe, getTemplate } from './registry.js';

export const COMPILER_VERSION = 'aios-compiler/1';

export type CompileResult =
  | {
      ok: true;
      template: string;
      templateVersion: string;
      compilerVersion: string;
      artifactJson: unknown;
      digest: string;
    }
  | {
      ok: false;
      status: 'REJECTED';
      errors: string[];
    };

export type CompileAndStoreResult =
  | (Extract<CompileResult, { ok: true }> & {
      artifactId: string;
      reused: boolean;
      storedDigest: string;
    })
  | Extract<CompileResult, { ok: false }>;

function rejected(...errors: string[]): Extract<CompileResult, { ok: false }> {
  return {
    ok: false,
    status: 'REJECTED',
    errors: errors.map((e) => redactSecrets(e)),
  };
}

/**
 * Compile Skill IR into a deterministic FlowArtifact JSON + digest.
 * Fail-closed: unknown templates never free-generate.
 */
export function compileSkillIr(input: unknown): CompileResult {
  let ir;
  try {
    ir = parseSkillIr(input);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return rejected(msg);
  }

  const template = getTemplate(ir.template);
  if (!template) {
    return rejected(`unknown template: ${ir.template} (no free-form generation)`);
  }

  const slotsParsed = template.slotSchema.safeParse(ir.slots);
  if (!slotsParsed.success) {
    const detail = slotsParsed.error.issues
      .map((i) => `${i.path.join('.') || 'slots'}: ${i.message}`)
      .join('; ');
    return rejected(`invalid slots for template ${template.id}: ${detail}`);
  }

  let artifactJson: unknown;
  try {
    artifactJson = template.buildGraph(slotsParsed.data as Record<string, unknown>);
    assertGraphSafe(artifactJson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return rejected(msg);
  }

  let digest: string;
  try {
    digest = computeFlowArtifactDigest(artifactJson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return rejected(`digest failed: ${msg}`);
  }

  return {
    ok: true,
    template: template.id,
    templateVersion: template.version,
    compilerVersion: COMPILER_VERSION,
    artifactJson,
    digest,
  };
}

/**
 * Compile and persist FlowArtifact (content-addressed).
 * REJECTED paths perform zero DB writes.
 * Secret material in IR → REJECTED (digest changes under deepRedact).
 */
export async function compileAndStore(
  input: unknown,
  opts: { skillVersionId?: string | null; createdBy?: string | null } = {},
): Promise<CompileAndStoreResult> {
  const compiled = compileSkillIr(input);
  if (!compiled.ok) {
    return compiled;
  }

  // Fail-closed secret gate: if deep-redact changes the digest, IR carried secret material.
  const redactedJson = deepRedactSecrets(compiled.artifactJson);
  let redactedDigest: string;
  try {
    redactedDigest = computeFlowArtifactDigest(redactedJson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return rejected(`post-redact digest failed: ${msg}`);
  }

  if (redactedDigest !== compiled.digest) {
    return rejected(
      'secret material in IR: artifact digest changed after deepRedactSecrets (refusing to store inconsistent digest)',
    );
  }

  try {
    const stored = await createFlowArtifact({
      runtimeKind: 'LANGFLOW',
      template: compiled.template,
      templateVersion: compiled.templateVersion,
      compilerVersion: compiled.compilerVersion,
      artifactJson: redactedJson,
      skillVersionId: opts.skillVersionId ?? null,
      createdBy: opts.createdBy ?? null,
    });

    if (stored.digest !== compiled.digest) {
      // createFlowArtifact redacts again; mismatch means secret slipped past pre-check — fail-closed.
      throw new Error(
        `stored digest mismatch after createFlowArtifact: expected ${compiled.digest}, got ${stored.digest} (secret material or redact drift — refusing inconsistent store)`,
      );
    }

    return {
      ...compiled,
      artifactId: stored.id,
      reused: stored.reused,
      storedDigest: stored.digest,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Fail-closed: do not return ok with inconsistent digest
    return rejected(msg);
  }
}
