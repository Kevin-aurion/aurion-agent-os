import { deepRedactSecrets } from '../memory/deepredact.js';

export type BuilderTestProgressStage =
  | 'QUEUED'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'REWORKING'
  | 'COMPLETED';

export type BuilderTestProgressRound = {
  round: number;
  status: string;
  approved: boolean | null;
  summary: string;
  startedAt: string;
  endedAt: string | null;
};

export type BuilderTestProgressDto = {
  runId: string;
  status: string;
  stage: BuilderTestProgressStage;
  currentRound: number;
  maxRounds: number;
  startedAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  elapsedSeconds: number;
  latestUpdateAt: string;
  latestMessage: string;
  rounds: BuilderTestProgressRound[];
};

type ProgressRun = {
  id: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  stoppedAt: string | null;
};

type ProgressStep = {
  round: number;
  status: string;
  approved: boolean | null;
  verdict: string | null;
  startedAt: Date;
  endedAt: Date | null;
};

const HARD_TIMEOUT_MS = 20 * 60_000;

function safeSummary(value: string | null): string {
  const redacted = String(deepRedactSecrets(value ?? ''))
    .replace(/^#+\s*/gm, '')
    .replace(/^Verdict\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.slice(0, 400);
}

export function deriveBuilderTestProgress(args: {
  run: ProgressRun;
  steps: ProgressStep[];
  maxRounds: number;
  now?: Date;
}): BuilderTestProgressDto {
  const now = args.now ?? new Date();
  const steps = [...args.steps].sort((a, b) => a.round - b.round);
  const last = steps.at(-1);
  const finished = args.run.status !== 'RUNNING';
  const currentRound = finished
    ? Math.max(1, last?.round ?? 1)
    : Math.min(args.maxRounds, Math.max(1, (last?.round ?? 0) + 1));
  const stage: BuilderTestProgressStage = finished
    ? 'COMPLETED'
    : last?.approved === false || last?.status === 'rejected'
      ? 'REWORKING'
      : 'EXECUTING';
  const latestMessage = finished
    ? args.run.status === 'SUCCEEDED'
      ? '跨模型驗證完成，試跑已通過'
      : `試跑已結束（${args.run.status}${args.run.stoppedAt ? `，停在 ${args.run.stoppedAt}` : ''}）`
    : stage === 'REWORKING'
      ? `第 ${currentRound} 輪正在依驗證意見修正`
      : `第 ${currentRound} 輪正在執行測試工作`;
  const effectiveEnd = args.run.finishedAt ?? now;
  const latestUpdate = last?.endedAt ?? last?.startedAt ?? args.run.startedAt;

  return {
    runId: args.run.id,
    status: args.run.status,
    stage,
    currentRound,
    maxRounds: Math.max(1, args.maxRounds),
    startedAt: args.run.startedAt.toISOString(),
    finishedAt: args.run.finishedAt?.toISOString() ?? null,
    deadlineAt: new Date(args.run.startedAt.getTime() + HARD_TIMEOUT_MS).toISOString(),
    elapsedSeconds: Math.max(0, Math.floor((effectiveEnd.getTime() - args.run.startedAt.getTime()) / 1000)),
    latestUpdateAt: latestUpdate.toISOString(),
    latestMessage,
    rounds: steps.map((step) => ({
      round: step.round,
      status: step.status,
      approved: step.approved,
      summary: safeSummary(step.verdict),
      startedAt: step.startedAt.toISOString(),
      endedAt: step.endedAt?.toISOString() ?? null,
    })),
  };
}
