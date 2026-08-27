// In-process abort registry for Agent Builder Claude calls.
//
// The database is the durable status ledger (ABANDONED / SUPERSEDED). This
// map only owns the live AbortController for an in-flight `runClaude` so an
// abandon or a newer iteration can stop the CLI instead of waiting out the
// timeout. The registry is never persisted; a process restart drops it, which
// is acceptable because stale ANALYZING rows are reclaimed after 30s.
//
// Lifecycle
// ---------
// interview:<sessionId>
//   begin  — planAdaptiveInterviewTurn, once a session id is known
//   abort  — abandonBuilderSession, or a newer interview turn for the same session
//   finish — planAdaptiveInterviewTurn `finally` (only deletes if still this controller)
//
// iteration:<iterationId>
//   begin  — processBuilderEvolution, after the row is claimed
//   abort  — the iteration is marked SUPERSEDED, or the parent session is abandoned
//   finish — processBuilderEvolution `finally`
import type { RunClaudeOpts, RunClaudeResult } from '../engine/claude.js';

export type BuilderClaudeFn = (opts: RunClaudeOpts) => Promise<RunClaudeResult>;

const interviewBySession = new Map<string, AbortController>();
const iterationById = new Map<string, AbortController>();
const iterationsBySession = new Map<string, Set<string>>();

export function beginBuilderInterviewCall(sessionId: string): AbortController {
  const existing = interviewBySession.get(sessionId);
  if (existing && !existing.signal.aborted) {
    existing.abort();
  }
  const controller = new AbortController();
  interviewBySession.set(sessionId, controller);
  return controller;
}

export function finishBuilderInterviewCall(sessionId: string, controller: AbortController): void {
  if (interviewBySession.get(sessionId) === controller) {
    interviewBySession.delete(sessionId);
  }
}

export function beginBuilderIterationCall(sessionId: string, iterationId: string): AbortController {
  const existing = iterationById.get(iterationId);
  if (existing && !existing.signal.aborted) {
    existing.abort();
  }
  const controller = new AbortController();
  iterationById.set(iterationId, controller);
  let bucket = iterationsBySession.get(sessionId);
  if (!bucket) {
    bucket = new Set();
    iterationsBySession.set(sessionId, bucket);
  }
  bucket.add(iterationId);
  return controller;
}

export function finishBuilderIterationCall(sessionId: string, iterationId: string, controller: AbortController): void {
  if (iterationById.get(iterationId) === controller) {
    iterationById.delete(iterationId);
  }
  const bucket = iterationsBySession.get(sessionId);
  bucket?.delete(iterationId);
  if (bucket && bucket.size === 0) iterationsBySession.delete(sessionId);
}

/** Abort the in-flight evolution `runClaude` for one iteration (SUPERSEDED). */
export function abortBuilderIteration(iterationId: string): boolean {
  const controller = iterationById.get(iterationId);
  if (!controller) return false;
  if (!controller.signal.aborted) controller.abort();
  return true;
}

/**
 * Abort every in-flight Builder Claude call owned by this session:
 * the adaptive interview planner and any evolution compilers.
 * Called from abandonBuilderSession.
 */
export function abortBuilderSessionWork(sessionId: string): void {
  const interview = interviewBySession.get(sessionId);
  if (interview && !interview.signal.aborted) interview.abort();
  const ids = iterationsBySession.get(sessionId);
  if (!ids) return;
  for (const iterationId of ids) abortBuilderIteration(iterationId);
}

export function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}
