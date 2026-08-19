/**
 * Workbench V2 worksession projection layer.
 *
 * Projects Native and Langflow runtime events into one UI-safe session shape.
 * Runtime ≠ Engine: wire-format fields (manifest, flow nodes, model family,
 * resumeToken, runDir, …) never leave this module into UI state.
 */

export const MAX_SESSION_LOGS = 200;

export interface SessionStep {
  stepKey: string;
  round: number;
  phase: string;
  kindLabel: string;
  isTool: boolean;
}

export interface WorkSessionState {
  runId: string | null;
  status: 'idle' | 'running' | 'awaiting_approval' | 'finished' | 'failed';
  steps: SessionStep[];
  logs: string[];
  approvalPending: boolean;
  finishedStatus: string | null;
}

export interface RunArtifact {
  stepKey: string;
  content: string;
}

export interface RunDetailView {
  id: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: Array<{ stepKey: string; round: number; phase: string; verdict: string | null }>;
  artifacts: RunArtifact[];
}

export interface WorkbenchControls {
  canConfirmSkill: boolean;
  canPropose: boolean;
  canDecideApproval: boolean;
  canManageRuntime: boolean;
  showAdminLink: boolean;
}

export function createWorkSession(runId?: string | null): WorkSessionState {
  return {
    runId: runId ?? null,
    status: 'idle',
    steps: [],
    logs: [],
    approvalPending: false,
    finishedStatus: null,
  };
}

export function stepTypeLabel(type: string | undefined | null): string {
  switch (type) {
    case 'DO':
      return '處理';
    case 'TOOL':
      return '使用工具';
    case 'AGENT':
      return '協作';
    case 'CONDITION':
      return '判斷';
    case 'NOTIFY':
      return '通知';
    case 'COMPUTER_CONTROL':
      return '操作電腦';
    default:
      return '處理步驟';
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function makeSessionStep(
  stepKey: string,
  round: number,
  phase: string,
  type: unknown,
): SessionStep {
  const t = typeof type === 'string' ? type : undefined;
  return {
    stepKey,
    round,
    phase,
    kindLabel: stepTypeLabel(t),
    isTool: t === 'TOOL' || t === 'COMPUTER_CONTROL',
  };
}

/**
 * Pure reducer. Returns the same state reference when the frame is irrelevant
 * or invalid; never throws; never mutates the input state.
 */
export function reduceSessionFrame(
  state: WorkSessionState,
  frame: { topic?: string; payload?: unknown },
): WorkSessionState {
  try {
    const topic = frame?.topic;
    if (typeof topic !== 'string' || !topic) return state;

    const payload = asRecord(frame.payload);
    if (!payload) return state;

    const payloadRunId = payload.runId;
    if (!isNonEmptyString(payloadRunId)) return state;

    // Unbound session: only run.started may bind a runId.
    if (state.runId === null) {
      if (topic !== 'run.started') return state;
      return {
        ...state,
        runId: payloadRunId,
        status: 'running',
      };
    }

    // Bound session: only matching runId.
    if (payloadRunId !== state.runId) return state;

    switch (topic) {
      case 'run.started':
        return {
          ...state,
          status: 'running',
        };

      case 'run.step': {
        if (!isNonEmptyString(payload.stepKey) || !isNonEmptyString(payload.phase)) {
          return state;
        }
        const stepKey = payload.stepKey;
        const phase = payload.phase;
        const round = typeof payload.round === 'number' && Number.isFinite(payload.round)
          ? payload.round
          : 0;
        const nextStep = makeSessionStep(stepKey, round, phase, payload.type);
        const steps = [...state.steps];
        const idx = steps.findIndex((s) => s.stepKey === stepKey && s.round === round);
        if (idx >= 0) steps[idx] = nextStep;
        else steps.push(nextStep);

        const awaiting = phase === 'awaiting_review';
        return {
          ...state,
          steps,
          ...(awaiting
            ? { status: 'awaiting_approval' as const, approvalPending: true }
            : {}),
        };
      }

      case 'run.log': {
        if (typeof payload.line !== 'string') return state;
        const logs = [...state.logs, payload.line];
        const capped =
          logs.length > MAX_SESSION_LOGS ? logs.slice(logs.length - MAX_SESSION_LOGS) : logs;
        return { ...state, logs: capped };
      }

      case 'approval.requested':
        // resumeToken and other sensitive fields are intentionally discarded.
        return {
          ...state,
          approvalPending: true,
          status: 'awaiting_approval',
        };

      case 'run.finished': {
        const finishedStatus =
          typeof payload.status === 'string' ? payload.status : null;
        return {
          ...state,
          status: finishedStatus === 'SUCCEEDED' ? 'finished' : 'failed',
          finishedStatus,
          approvalPending: false,
        };
      }

      default:
        return state;
    }
  } catch {
    // fail-safe: never throw from the reducer
    return state;
  }
}

/**
 * Whitelist projection of GET /api/runs/:id raw row.
 * Non-object / missing id → null; never throws.
 */
export function projectRunDetail(raw: unknown): RunDetailView | null {
  try {
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) return null;

    const stepsRaw = Array.isArray(o.steps) ? o.steps : [];
    const steps: RunDetailView['steps'] = [];
    for (const item of stepsRaw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const s = item as Record<string, unknown>;
      steps.push({
        stepKey: typeof s.stepKey === 'string' ? s.stepKey : '',
        round: typeof s.round === 'number' && Number.isFinite(s.round) ? s.round : 0,
        // RunStep.status maps onto view.phase
        phase: typeof s.status === 'string' ? s.status : '',
        verdict:
          s.verdict === null || s.verdict === undefined
            ? null
            : typeof s.verdict === 'string'
              ? s.verdict
              : String(s.verdict),
      });
    }

    const artifacts: RunArtifact[] = [];
    const output = o.output;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      const results = (output as Record<string, unknown>).results;
      if (Array.isArray(results)) {
        for (const item of results) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const r = item as Record<string, unknown>;
          if (typeof r.output !== 'string' || r.output.length === 0) continue;
          artifacts.push({
            stepKey: typeof r.stepKey === 'string' ? r.stepKey : '',
            content: r.output,
          });
        }
      }
    }

    return {
      id: o.id,
      status: typeof o.status === 'string' ? o.status : '',
      startedAt: typeof o.startedAt === 'string' ? o.startedAt : null,
      finishedAt: typeof o.finishedAt === 'string' ? o.finishedAt : null,
      steps,
      artifacts,
    };
  } catch {
    return null;
  }
}

/**
 * Workbench-surface control flags by role.
 * Approval decisions and runtime management stay admin-only (always false here).
 * Pure function — no auth module dependency.
 */
export function visibleWorkbenchControls(
  role: string | undefined | null,
): WorkbenchControls {
  const isFde = role === 'OWNER' || role === 'TRAINER';
  const loggedIn = role === 'OWNER' || role === 'TRAINER' || role === 'MEMBER';
  return {
    canConfirmSkill: isFde,
    canPropose: loggedIn,
    canDecideApproval: false,
    canManageRuntime: false,
    showAdminLink: isFde,
  };
}

/**
 * Unbound session 只允許綁定「本對話觸發」的 run（triggeredBy === `chat:<conversationId>`）。
 * 過濾 cron / 其他使用者 / 其他對話的全域 run.started，避免右欄被劫持。
 */
export function shouldBindRunStart(
  payload: unknown,
  activeConversationId: string | null | undefined,
): boolean {
  try {
    if (
      activeConversationId === null ||
      activeConversationId === undefined ||
      typeof activeConversationId !== 'string' ||
      activeConversationId.length === 0
    ) {
      return false;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return false;
    }
    const p = payload as Record<string, unknown>;
    if (typeof p.runId !== 'string' || p.runId.length === 0) return false;
    return p.triggeredBy === `chat:${activeConversationId}`;
  } catch {
    return false;
  }
}
