/**
 * Pure projection layer: FDE Skill version / diff / promote-gate / rollback UX.
 * No React, no IO. All functions are pure and must not mutate inputs.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type DiffRowType = 'same' | 'add' | 'del';

export interface DiffRow {
  type: DiffRowType;
  text: string;
}

/** Minimal version row from GET /api/skills/:id/versions (or subset). */
export interface SkillVersionInput {
  id: string;
  version: number;
  channel: string;
  contentHash: string;
  createdAt: string;
  contentMd?: string;
  schemaVersion?: string | null;
  createdBy?: string | null;
}

export type VersionRole = 'stable' | 'canary';

export interface TimelineVersion extends SkillVersionInput {
  roles: VersionRole[];
}

export interface GateCheck {
  key: string;
  ok: boolean;
  reason: string;
  evalRunId?: string;
}

export interface PromoteGateInput {
  canPromote: boolean;
  checks: GateCheck[];
}

export interface GateGap {
  key: string;
  label: string;
  reason: string;
}

export interface GateSummary {
  canPromote: boolean;
  gaps: GateGap[];
}

export interface RollbackDescription {
  fromVersion?: number;
  toVersion?: number;
  retainedCount: number;
}

const GATE_LABELS: Record<string, string> = {
  skill_confirmed: 'FDE 確認',
  version_exists: '版本存在',
  eval_passed: '評測通過',
  no_unresolved_high_risk: '無未解高風險',
  codex_gate: '執行引擎合規',
};

/** 繁中業務標籤（未知 key 原樣回傳）。 */
export function gateCheckLabel(key: string): string {
  return GATE_LABELS[key] ?? key;
}

// ── diffLines (LCS line-level) ────────────────────────────────────────────────

function splitLines(s: string): string[] {
  if (s === '') return [];
  // Keep empty trailing segment only when content ends with newline? Standard
  // line-split: "a\nb" → ["a","b"]; "" → []. Do not mutate input.
  return s.split('\n');
}

/**
 * LCS-based line diff. Does not mutate inputs.
 */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[0..i) and b[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack
  const rev: DiffRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      rev.push({ type: 'same', text: a[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      rev.push({ type: 'add', text: b[j - 1]! });
      j -= 1;
    } else {
      rev.push({ type: 'del', text: a[i - 1]! });
      i -= 1;
    }
  }
  rev.reverse();
  return rev;
}

// ── buildVersionTimeline ─────────────────────────────────────────────────────

/**
 * Project versions newest-first with stable/canary roles. Does not mutate input.
 */
export function buildVersionTimeline(
  versions: readonly SkillVersionInput[],
  stableVersionId: string | null | undefined,
  canaryVersionId: string | null | undefined,
): TimelineVersion[] {
  const sorted = versions
    .map((v) => ({ ...v }))
    .sort((x, y) => y.version - x.version);

  return sorted.map((v) => {
    const roles: VersionRole[] = [];
    if (stableVersionId && v.id === stableVersionId) roles.push('stable');
    if (canaryVersionId && v.id === canaryVersionId) roles.push('canary');
    return { ...v, roles };
  });
}

// ── summarizeGate ────────────────────────────────────────────────────────────

/**
 * Convert failed promote-gate checks into Traditional Chinese gap list.
 */
export function summarizeGate(gate: PromoteGateInput): GateSummary {
  const gaps: GateGap[] = [];
  for (const c of gate.checks) {
    if (c.ok) continue;
    gaps.push({
      key: c.key,
      label: GATE_LABELS[c.key] ?? c.key,
      reason: c.reason,
    });
  }
  return {
    canPromote: gate.canPromote,
    gaps,
  };
}

// ── describeRollback ─────────────────────────────────────────────────────────

/**
 * Numbers for rollback confirm copy. History is retained (count = versions.length).
 */
export function describeRollback(
  versions: readonly SkillVersionInput[],
  fromVersionId: string | null | undefined,
  toVersionId: string | null | undefined,
): RollbackDescription {
  let fromVersion: number | undefined;
  let toVersion: number | undefined;
  for (const v of versions) {
    if (fromVersionId && v.id === fromVersionId) fromVersion = v.version;
    if (toVersionId && v.id === toVersionId) toVersion = v.version;
  }
  return {
    fromVersion,
    toVersion,
    retainedCount: versions.length,
  };
}
