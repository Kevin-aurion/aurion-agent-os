/**
 * Pure projection layer: FDE unified Proposal / Approval review inbox.
 * No React, no IO. All functions are pure and must not mutate inputs.
 */

export type ReviewKind = 'proposal' | 'run_approval';

export interface ProposalRow {
  id: string;
  agentId: string;
  runId?: string | null;
  source: string;
  proposedBy: string;
  targetType: string;
  targetId?: string | null;
  proposedChange: unknown;
  severity: string;
  confidence?: number | null;
  status: string;
  createdAt: string;
  agent?: { id: string; name: string; slug: string } | null;
}

export interface ApprovalRow {
  id: string;
  runId: string;
  agentId: string;
  reason: string;
  payload: unknown;
  status: string;
  createdAt: string;
  agent?: { id: string; name: string; slug: string; riskTier: string } | null;
}

export interface ReviewItem {
  key: string;
  kind: ReviewKind;
  id: string;
  agentId: string;
  agentName: string;
  requester: string;
  risk: 'high' | 'medium' | 'low';
  source: string;
  summary: string;
  createdAt: string;
  raw: ProposalRow | ApprovalRow;
}

export interface InboxFilter {
  kind?: 'all' | ReviewKind;
  risk?: 'all' | 'high' | 'medium' | 'low';
  source?: string;
  requester?: string;
  agentId?: string;
}

export interface DiffRow {
  key: string;
  before: string | null;
  after: string | null;
  changed: boolean;
}

export type ApprovalSignal = 'aios-approval' | 'informational';

export interface AuditRowLite {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  hash?: string | null;
  prevHash?: string | null;
  createdAt: string;
}

export interface DecisionEvidence {
  decidedStatus: string;
  zeroChange: boolean;
  resultingVersionId: string | null;
  auditAction: string | null;
  auditHash: string | null;
  auditPrevHash: string | null;
  chainLinked: boolean;
}

const RISK_LEVELS = new Set(['high', 'medium', 'low']);

function normalizeRisk(raw: unknown): 'high' | 'medium' | 'low' {
  const v = String(raw ?? '').toLowerCase();
  if (RISK_LEVELS.has(v)) return v as 'high' | 'medium' | 'low';
  return 'medium';
}

function agentDisplayName(agentId: string, name?: string | null): string {
  if (name) return name;
  return agentId.slice(0, 8);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

export function proposalActionOf(proposedChange: unknown): string | undefined {
  const rec = asRecord(proposedChange);
  return typeof rec?.action === 'string' ? rec.action : undefined;
}

export interface BuilderLessonCard {
  action: 'builder_prompt_lesson' | 'builder_prompt_lesson_merge';
  title: string;
  lessonText: string;
  evidence: string;
}

function formatEvidence(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return '';
  const turns = raw
    .filter((item): item is number | string => typeof item === 'number' || typeof item === 'string')
    .map((item) => String(item));
  if (turns.length === 0) return '';
  return `第 ${turns.join('、')} 輪`;
}

/** Project builder_prompt_lesson(+merge) payload for the unified inbox card. */
export function builderLessonCard(proposedChange: unknown): BuilderLessonCard | null {
  const rec = asRecord(proposedChange);
  if (!rec) return null;
  if (rec.action !== 'builder_prompt_lesson' && rec.action !== 'builder_prompt_lesson_merge') {
    return null;
  }
  const title = typeof rec.title === 'string' ? rec.title : '';
  const lessonText = typeof rec.lessonText === 'string' ? rec.lessonText : '';
  return {
    action: rec.action,
    title,
    lessonText,
    evidence: formatEvidence(rec.evidence),
  };
}

function projectProposal(row: ProposalRow): ReviewItem {
  const lesson = builderLessonCard(row.proposedChange);
  return {
    key: `proposal:${row.id}`,
    kind: 'proposal',
    id: row.id,
    agentId: row.agentId,
    agentName: agentDisplayName(row.agentId, row.agent?.name),
    requester: row.proposedBy,
    risk: normalizeRisk(row.severity),
    source: row.source,
    summary: lesson?.title || row.targetType,
    createdAt: row.createdAt,
    raw: row,
  };
}

function projectApproval(row: ApprovalRow): ReviewItem {
  return {
    key: `approval:${row.id}`,
    kind: 'run_approval',
    id: row.id,
    agentId: row.agentId,
    agentName: agentDisplayName(row.agentId, row.agent?.name),
    requester: 'system',
    risk: normalizeRisk(row.agent?.riskTier),
    source: 'RUN',
    summary: row.reason,
    createdAt: row.createdAt,
    raw: row,
  };
}

/** Merge proposals + approvals into one inbox, newest first. Does not mutate inputs. */
export function mergeInbox(proposals: ProposalRow[], approvals: ApprovalRow[]): ReviewItem[] {
  const items: ReviewItem[] = [
    ...proposals.map(projectProposal),
    ...approvals.map(projectApproval),
  ];
  items.sort((a, b) => {
    if (a.createdAt === b.createdAt) return 0;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return items;
}

/** Filter inbox items. Undefined / 'all' fields do not filter. Does not mutate input. */
export function filterInbox(items: ReviewItem[], f: InboxFilter): ReviewItem[] {
  return items.filter((item) => {
    if (f.kind !== undefined && f.kind !== 'all' && item.kind !== f.kind) return false;
    if (f.risk !== undefined && f.risk !== 'all' && item.risk !== f.risk) return false;
    if (f.source !== undefined && f.source !== 'all' && item.source !== f.source) return false;
    if (f.requester !== undefined && f.requester !== 'all' && item.requester !== f.requester) return false;
    if (f.agentId !== undefined && f.agentId !== 'all' && item.agentId !== f.agentId) return false;
    return true;
  });
}

function stringifyValue(v: unknown): string {
  return JSON.stringify(v);
}

/**
 * Structured diff for a proposal's proposedChange.
 * RESTRICTION: union of current + patch keys (alpha-sorted).
 * Other targetTypes: object keys / string content / generic change row.
 */
export function proposalDiff(
  targetType: string,
  proposedChange: unknown,
  current?: Record<string, unknown> | null,
): DiffRow[] {
  if (targetType === 'RESTRICTION') {
    const patch =
      proposedChange !== null &&
      typeof proposedChange === 'object' &&
      !Array.isArray(proposedChange)
        ? (proposedChange as Record<string, unknown>)
        : {};
    const base = current ?? {};
    const keys = Array.from(new Set([...Object.keys(base), ...Object.keys(patch)])).sort();
    const merged: Record<string, unknown> = { ...base, ...patch };
    return keys.map((key) => {
      const hasBefore = Object.prototype.hasOwnProperty.call(base, key);
      const before = hasBefore ? stringifyValue(base[key]) : null;
      const after = stringifyValue(merged[key]);
      return { key, before, after, changed: before !== after };
    });
  }

  if (
    proposedChange !== null &&
    typeof proposedChange === 'object' &&
    !Array.isArray(proposedChange)
  ) {
    const obj = proposedChange as Record<string, unknown>;
    return Object.keys(obj).map((key) => ({
      key,
      before: null,
      after: stringifyValue(obj[key]),
      changed: true,
    }));
  }

  if (typeof proposedChange === 'string') {
    return [
      {
        key: 'content',
        before: null,
        after: proposedChange.slice(0, 500),
        changed: true,
      },
    ];
  }

  return [
    {
      key: 'change',
      before: null,
      after: stringifyValue(proposedChange),
      changed: true,
    },
  ];
}

/**
 * Fail-closed: only exact AIOS approval.request is actionable.
 * Langflow / runtime / checkpoint payloads must never be treated as approval.
 */
export function classifyApprovalSignal(input: {
  origin?: string;
  topic?: string;
  payload?: unknown;
}): ApprovalSignal {
  if (input.origin === 'aios' && input.topic === 'approval.request') {
    return 'aios-approval';
  }
  return 'informational';
}

/** Fail-closed role gate: only exact OWNER or TRAINER. */
export function canReview(role: string | null | undefined): boolean {
  return role === 'OWNER' || role === 'TRAINER';
}

function readNestedStatus(response: unknown): string {
  const root = asRecord(response);
  if (!root) return 'UNKNOWN';
  const proposal = asRecord(root.proposal);
  if (proposal && typeof proposal.status === 'string') return proposal.status;
  if (typeof root.status === 'string') return root.status;
  return 'UNKNOWN';
}

function readResultingVersionId(response: unknown): string | null {
  const root = asRecord(response);
  if (!root) return null;
  if (typeof root.resultingVersionId === 'string') return root.resultingVersionId;
  if (root.resultingVersionId === null) {
    // explicit null on root wins over nested
  }
  const proposal = asRecord(root.proposal);
  if (proposal) {
    if (typeof proposal.resultingVersionId === 'string') return proposal.resultingVersionId;
    if (proposal.resultingVersionId === null) return null;
  }
  if (root.resultingVersionId === null) return null;
  return null;
}

const PROPOSAL_AUDIT_ACTIONS = new Set(['proposal.approved', 'proposal.rejected']);
const APPROVAL_AUDIT_ACTIONS = new Set(['approval.approved', 'approval.rejected']);

function isChainHash(hash: string | null | undefined): boolean {
  return hash != null && hash !== '';
}

/** Build post-decision evidence from API response + recent audit rows. */
export function buildDecisionEvidence(args: {
  kind: ReviewKind;
  decision: 'approve' | 'reject';
  targetId: string;
  response: unknown;
  auditRows: AuditRowLite[];
}): DecisionEvidence {
  const decidedStatus = readNestedStatus(args.response);
  const resultingVersionId = readResultingVersionId(args.response);
  const zeroChange = args.decision === 'reject' && resultingVersionId === null;

  const expectedEntity = args.kind === 'proposal' ? 'ChangeProposal' : 'ApprovalRequest';
  const expectedActions =
    args.kind === 'proposal' ? PROPOSAL_AUDIT_ACTIONS : APPROVAL_AUDIT_ACTIONS;

  const matches = args.auditRows.filter(
    (row) =>
      row.entity === expectedEntity &&
      row.entityId === args.targetId &&
      expectedActions.has(row.action),
  );

  let best: AuditRowLite | null = null;
  for (const row of matches) {
    if (!best || row.createdAt > best.createdAt) best = row;
  }

  if (!best) {
    return {
      decidedStatus,
      zeroChange,
      resultingVersionId,
      auditAction: null,
      auditHash: null,
      auditPrevHash: null,
      chainLinked: false,
    };
  }

  const auditHash = best.hash ?? null;
  const auditPrevHash = best.prevHash ?? null;
  return {
    decidedStatus,
    zeroChange,
    resultingVersionId,
    auditAction: best.action,
    auditHash,
    auditPrevHash,
    chainLinked: isChainHash(auditHash),
  };
}
