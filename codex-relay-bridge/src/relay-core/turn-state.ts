/**
 * Per-thread write lock (promise-chain mutex) and turn idle/active state machine.
 */

type AsyncFn<T> = () => Promise<T>;

export class ThreadLocks {
  private readonly chains = new Map<string, Promise<unknown>>();

  async withThreadLock<T>(threadId: string, fn: AsyncFn<T>): Promise<T> {
    const prev = this.chains.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Chain: wait for prev, then hold gate until fn completes
    const next = prev.then(
      () => gate,
      () => gate,
    );
    this.chains.set(threadId, next);

    await prev.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Turn state transitions are applied on the TaskRecord by RelayCore/Approvals
 * based on turn/start success, turn/started, and turn/completed notifications.
 *
 * idle → active: turn/start success or turn/started (record currentTurnId)
 * active → idle: turn/completed matching turnId
 */
export type TurnMode = "turn_start" | "turn_steer";

export function selectTurnMode(status: string, currentTurnId: string | null): {
  mode: TurnMode;
  expectedTurnId?: string;
} {
  if (status === "active" && currentTurnId) {
    return { mode: "turn_steer", expectedTurnId: currentTurnId };
  }
  return { mode: "turn_start" };
}
