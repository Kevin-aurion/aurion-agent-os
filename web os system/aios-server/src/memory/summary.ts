// Deterministic, rule-based run/chat summaries for memory precipitation.
// Phase 1 intentionally does NOT call an LLM here (acceptability + cost).
import type { RunOutcome } from '../engine/types.js';

const MAX_OUTPUT_CHARS = 400;

function clip(s: string, n = MAX_OUTPUT_CHARS): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

function statusLabel(status: string | undefined): string {
  switch (status) {
    case 'SUCCEEDED':
      return '成功';
    case 'FAILED':
      return '失敗';
    case 'CANCELLED':
      return '取消';
    case 'AWAITING_REVIEW':
      return '待審';
    case 'RUNNING':
      return '進行中';
    default:
      return status || '未知';
  }
}

/** Extract a short deterministic summary of a finished run. */
export function summarizeRun(outcome: RunOutcome, opts?: { workflowName?: string }): string {
  const status = statusLabel(outcome.status);
  const wf = opts?.workflowName ? `工作流「${opts.workflowName}」` : '執行';
  const keySteps = (outcome.results ?? [])
    .filter((r) => r.output && !r.skipped)
    .slice(0, 3)
    .map((r) => {
      const head = clip(r.output, 120);
      return `- [${r.stepKey}] ${r.ok ? 'ok' : 'fail'}: ${head}`;
    });
  const lastOk = [...(outcome.results ?? [])].reverse().find((r) => r.ok && r.output?.trim());
  const artifact = lastOk ? clip(lastOk.output) : '';
  const lines = [
    `${wf}狀態：${status}（runId=${outcome.runId}）`,
    outcome.stoppedAt ? `停止於步驟：${outcome.stoppedAt}` : null,
    keySteps.length ? `關鍵步驟：\n${keySteps.join('\n')}` : null,
    artifact ? `主要產出：${artifact}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

/** Extract a short deterministic summary of one chat turn. */
export function summarizeChat(userMsg: string, reply: string): string {
  const u = clip(userMsg, 200);
  const a = clip(reply, 300);
  return `對話摘要\n使用者：${u}\n助理：${a}`;
}
