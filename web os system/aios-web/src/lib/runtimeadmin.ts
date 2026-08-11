/**
 * Pure projection layer: FDE Runtime artifact / readiness / deployment UX.
 * No React, no IO. All functions are pure and must not mutate inputs.
 */

// ── DTO types (aligned with backend admin runtime responses) ─────────────────

export interface ArtifactSkillInfo {
  id: string;
  name: string;
  version: number;
  schemaVersion: string | null;
}

export interface ArtifactRow {
  id: string;
  skillVersionId: string | null;
  workflowId: string | null;
  runtimeKind: string;
  template: string;
  templateVersion: string | null;
  compilerVersion: string;
  digest: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  digestOk: boolean;
  skill: ArtifactSkillInfo | null;
  activeDeployments: number;
}

export interface ReadinessCheck {
  key: string;
  ok: boolean;
  reason: string;
}

export interface ReadinessReport {
  canActivate: boolean;
  checks: ReadinessCheck[];
}

export interface DeploymentRow {
  id: string;
  artifactId: string;
  skillId: string;
  environment: string;
  channel: string;
  runtimeBinding?: unknown;
  deployedBy: string | null;
  active: boolean;
  activatedAt: string;
  deactivatedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
  reused?: boolean;
  digest?: string;
  artifactStatus?: string;
}

export interface ArtifactDetail {
  artifact: ArtifactRow & {
    artifactJson: unknown;
    metadata: unknown;
  };
  skillIr: { schemaVersion: string | null; specJson: unknown } | null;
  readiness: ReadinessReport;
  deployments: DeploymentRow[];
}

export interface ReadinessGap {
  key: string;
  label: string;
  reason: string;
}

export interface ReadinessSummary {
  canActivate: boolean;
  gaps: ReadinessGap[];
}

export interface DeploymentGroup {
  environment: string;
  channel: string;
  active?: DeploymentRow;
  history: DeploymentRow[];
}

const READINESS_LABELS: Record<string, string> = {
  digest_ok: '內容雜湊 Digest',
  status_validated: 'Runtime 驗證',
  skill_confirmed: 'FDE 技能確認',
  eval_passed: '評測通過',
  no_unresolved_high_risk: '無未解高風險',
  model_family_distinct: '執行/驗證模型分離',
};

/** 繁中業務標籤（未知 key 原樣回傳）。 */
export function readinessLabel(key: string): string {
  return READINESS_LABELS[key] ?? key;
}

/**
 * Project failing readiness checks as gaps. Does not mutate input.
 */
export function summarizeReadiness(r: ReadinessReport): ReadinessSummary {
  const gaps: ReadinessGap[] = r.checks
    .filter((c) => !c.ok)
    .map((c) => ({
      key: c.key,
      label: readinessLabel(c.key),
      reason: c.reason,
    }));
  return {
    canActivate: r.canActivate,
    gaps,
  };
}

/** First 12 hex chars of digest; invalid → '—'. */
export function shortDigest(digest: string): string {
  if (typeof digest !== 'string' || digest.length === 0) return '—';
  if (!/^[a-fA-F0-9]+$/.test(digest)) return '—';
  return digest.slice(0, 12);
}

/**
 * active → can kill, cannot rollback; inactive → can rollback, cannot kill.
 */
export function deploymentActions(row: {
  active: boolean;
}): { canRollback: boolean; canKill: boolean } {
  if (row.active) {
    return { canRollback: false, canKill: true };
  }
  return { canRollback: true, canKill: false };
}

/** Status → visual tone for badges. */
export function artifactStatusTone(
  status: string,
): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'VALIDATED') return 'ok';
  if (status === 'COMPILED') return 'warn';
  if (status === 'REJECTED') return 'bad';
  return 'muted';
}

/**
 * External Langflow sandbox URL (FDE visual test only — never equals publish).
 */
export function sandboxUrl(): string {
  const env =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_AIOS_LANGFLOW_SANDBOX_URL
      : undefined;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return 'http://127.0.0.1:7860';
}

/**
 * Group deployments by environment+channel.
 * Active (if any) is elevated; history sorted by activatedAt desc.
 * Does not mutate the input array or its elements.
 */
export function groupDeployments(rows: readonly DeploymentRow[]): DeploymentGroup[] {
  const map = new Map<string, DeploymentRow[]>();
  for (const row of rows) {
    const key = `${row.environment}\0${row.channel}`;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }

  const groups: DeploymentGroup[] = [];
  for (const [, groupRows] of map) {
    const sorted = [...groupRows].sort((a, b) => {
      const ta = Date.parse(a.activatedAt) || 0;
      const tb = Date.parse(b.activatedAt) || 0;
      return tb - ta;
    });
    const active = sorted.find((r) => r.active);
    const history = sorted.filter((r) => !r.active);
    const environment = sorted[0]!.environment;
    const channel = sorted[0]!.channel;
    groups.push({
      environment,
      channel,
      active,
      history,
    });
  }

  // Stable-ish order: PRODUCTION > STAGING > SANDBOX, then STABLE > CANARY
  const envOrder = (e: string) =>
    e === 'PRODUCTION' ? 0 : e === 'STAGING' ? 1 : e === 'SANDBOX' ? 2 : 9;
  const chOrder = (c: string) => (c === 'STABLE' ? 0 : c === 'CANARY' ? 1 : 9);
  groups.sort((a, b) => {
    const de = envOrder(a.environment) - envOrder(b.environment);
    if (de !== 0) return de;
    return chOrder(a.channel) - chOrder(b.channel);
  });

  return groups;
}
