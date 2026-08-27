/**
 * Host-local cancellation registry for native in-process runs.
 *
 * AIOS currently executes the native engine and its CLI children on one host,
 * so an AbortController is the authoritative way to stop the actual process.
 * The database remains the durable status ledger; this registry only owns the
 * live process handle and is deliberately never persisted.
 */
const activeRuns = new Map<string, AbortController>();

export function registerActiveRun(runId: string): AbortSignal {
  if (activeRuns.has(runId)) {
    throw new Error(`Run is already registered: ${runId}`);
  }
  const controller = new AbortController();
  activeRuns.set(runId, controller);
  return controller.signal;
}

export function cancelActiveRun(runId: string): boolean {
  const controller = activeRuns.get(runId);
  if (!controller) return false;
  if (!controller.signal.aborted) {
    controller.abort(new Error('Run cancelled by user'));
  }
  return true;
}

export function releaseActiveRun(runId: string): void {
  activeRuns.delete(runId);
}

export function isActiveRunRegistered(runId: string): boolean {
  return activeRuns.has(runId);
}
