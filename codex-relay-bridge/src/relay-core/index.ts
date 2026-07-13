/**
 * RelayCore facade — single App Server child manager + 5 tool methods.
 */

import { AppServerClient } from "./app-server-client.js";
import {
  ThreadRegistry,
  normalizeAndValidateProject,
  type TaskRecord,
} from "./thread-registry.js";
import { ThreadLocks, selectTurnMode } from "./turn-state.js";
import { IdempotencyStore } from "./idempotency.js";
import {
  EventStore,
  mapNotificationToEvent,
  extractThreadId,
} from "./event-store.js";
import { ApprovalsManager } from "./approvals.js";
import { BridgeError, isBridgeError } from "./errors.js";
import type { JsonRpcId } from "./rpc-types.js";

export interface RelayCoreOptions {
  codexBin?: string;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  approvalTimeoutMs?: number;
  packageVersion?: string;
  /** Extra env for app-server child. */
  childEnv?: Record<string, string | undefined>;
  /** Auto-start app-server on first tool call (default true). */
  autoStart?: boolean;
}

export interface StartTaskInput {
  project: string;
  message: string;
  idempotency_key: string;
}

export interface StartTaskOutput {
  task_id: string;
  thread_id: string;
  status: string;
  idempotent_replay: boolean;
}

export interface ContinueTaskInput {
  thread_id: string;
  message: string;
}

export interface ContinueTaskOutput {
  task_id: string;
  turn_id: string;
  mode: "turn_start" | "turn_steer";
  accepted: boolean;
  status: string;
}

export interface GetStatusInput {
  task_id?: string;
  thread_id?: string;
}

export interface GetStatusOutput {
  task_id: string;
  thread_id: string;
  status: string;
  current_turn_id: string | null;
  summary: string | null;
  pending_approvals: Array<{
    request_id: string;
    kind: string;
    summary: string;
    expires_at: number;
  }>;
  last_error: string | null;
  diagnostics: {
    dropped_events: number;
    unroutable_notifications: number;
  };
}

export interface ReadOutputInput {
  task_id: string;
  cursor?: number;
}

export interface RespondApprovalInput {
  request_id: string;
  decision: "allow" | "deny";
  note?: string;
}

export class RelayCore {
  readonly registry = new ThreadRegistry();
  readonly events = new EventStore();
  readonly idempotency = new IdempotencyStore();
  readonly locks = new ThreadLocks();
  readonly client: AppServerClient;
  readonly approvals: ApprovalsManager;
  private readonly autoStart: boolean;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private signalHandlersInstalled = false;

  constructor(opts: RelayCoreOptions = {}) {
    this.autoStart = opts.autoStart !== false;

    this.client = new AppServerClient({
      ...(opts.codexBin !== undefined ? { codexBin: opts.codexBin } : {}),
      ...(opts.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: opts.requestTimeoutMs }
        : {}),
      ...(opts.handshakeTimeoutMs !== undefined
        ? { handshakeTimeoutMs: opts.handshakeTimeoutMs }
        : {}),
      ...(opts.packageVersion !== undefined
        ? { packageVersion: opts.packageVersion }
        : {}),
      ...(opts.childEnv !== undefined ? { childEnv: opts.childEnv } : {}),
      onServerRequest: (req) => this.onServerRequest(req),
      onServerNotification: (notif) => this.onServerNotification(notif),
      onProtocolViolation: (info) => this.onProtocolViolation(info),
      onExit: (code, signal) => this.onAppServerExit(code, signal),
    });

    this.approvals = new ApprovalsManager({
      client: this.client,
      events: this.events,
      registry: this.registry,
      ...(opts.approvalTimeoutMs !== undefined
        ? { approvalTimeoutMs: opts.approvalTimeoutMs }
        : {}),
      resolveTaskId: (threadId) => {
        if (!threadId) return null;
        return this.registry.getByThreadId(threadId)?.taskId ?? null;
      },
    });
  }

  installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;
    const flush = () => {
      console.error("[relay-core] signal: flushing approvals fail-closed");
      this.approvals.flushAllDeny("SIGTERM/SIGINT");
      void this.client.shutdown().finally(() => process.exit(0));
    };
    process.on("SIGTERM", flush);
    process.on("SIGINT", flush);
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      await this.client.start();
      this.started = true;
    })().finally(() => {
      // Keep startPromise if started so concurrent waiters can share;
      // clear on failure so a later retry can re-enter.
      if (!this.started) this.startPromise = null;
    });
    return this.startPromise;
  }

  private async ensureStarted(): Promise<void> {
    // Phase 1: never auto-restart after a live connection was lost.
    if (this.client.isDegraded || !this.client.isConnected) {
      // Distinguish "never started" (may still start) from "was connected then died".
      if (this.startPromise || this.started || this.registry.list().length > 0) {
        // Wait for in-flight first start, if any
        if (this.startPromise && !this.started) {
          try {
            await this.startPromise;
          } catch {
            /* fall through */
          }
        }
        if (this.client.isDegraded || !this.client.isConnected) {
          throw new BridgeError(
            "disconnected",
            "app-server is disconnected (Phase 1: no auto-restart)",
          );
        }
      }
    }

    if (!this.started && this.autoStart) {
      await this.start();
    } else if (this.startPromise && !this.started) {
      // Background start in flight (e.g. from MCP boot) — wait rather than hang
      // or double-spawn.
      await this.startPromise;
    }
    if (!this.started) {
      throw new BridgeError(
        "degraded",
        "app-server is not ready (handshake incomplete or start failed)",
      );
    }
    await this.client.ensureReady();
  }

  private onServerRequest(req: {
    id: JsonRpcId;
    method: string;
    params: unknown;
  }): void {
    this.approvals.handleServerRequest(req);
  }

  private onServerNotification(notif: {
    method: string;
    params: unknown;
  }): void {
    const threadId = extractThreadId(notif.params);
    let task: TaskRecord | undefined;
    if (threadId) {
      task = this.registry.getByThreadId(threadId);
    }

    // Turn state machine
    if (notif.method === "turn/started") {
      const p = (notif.params ?? {}) as {
        threadId?: string;
        turn?: { id?: string };
      };
      const tid = p.threadId ?? threadId;
      const turnId = p.turn?.id;
      if (tid && turnId) {
        const rec = this.registry.getByThreadId(tid);
        if (rec) {
          this.registry.update(rec.taskId, {
            status: "active",
            currentTurnId: turnId,
          });
          task = this.registry.getByTaskId(rec.taskId);
        }
      }
    } else if (notif.method === "turn/completed") {
      const p = (notif.params ?? {}) as {
        threadId?: string;
        turn?: { id?: string };
      };
      const tid = p.threadId ?? threadId;
      const turnId = p.turn?.id;
      if (tid) {
        const rec = this.registry.getByThreadId(tid);
        if (rec) {
          // Only clear if matching current turn (or no current)
          if (!rec.currentTurnId || !turnId || rec.currentTurnId === turnId) {
            this.registry.update(rec.taskId, {
              status: "idle",
              currentTurnId: null,
            });
          }
          task = this.registry.getByTaskId(rec.taskId);
        }
      }
    }

    const mapped = mapNotificationToEvent(notif.method, notif.params);
    if (!mapped) return;

    if (!task) {
      // Unroutable
      this.events.recordUnroutable();
      console.error(
        `[relay-core] unroutable notification ${notif.method} threadId=${threadId ?? "?"}`,
      );
      return;
    }

    this.events.append(task.taskId, mapped);
  }

  private onProtocolViolation(info: {
    reason: string;
    raw: unknown;
    method?: string;
    id?: JsonRpcId;
  }): void {
    // Attach to most recent task if any
    const tasks = this.registry.list();
    const task = tasks[tasks.length - 1];
    if (task) {
      this.events.append(task.taskId, {
        type: "protocol_violation",
        text: info.reason,
        raw: info.raw,
        ...(info.method !== undefined ? { kind: info.method } : {}),
      });
    } else {
      this.events.recordUnroutable();
      console.error("[relay-core] protocol_violation (no task):", info.reason);
    }
  }

  private onAppServerExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const msg = `app-server exited code=${code} signal=${signal}`;
    console.error("[relay-core]", msg);
    this.approvals.markAllDeniedLocal(msg);
    this.registry.markAllDisconnected(msg);
    this.started = false;
  }

  // ─── Tool methods ───────────────────────────────────────────────

  async startTask(input: StartTaskInput): Promise<StartTaskOutput> {
    const { project, message, idempotency_key } = input;

    if (!message || message.length < 1) {
      throw new BridgeError("invalid_input", "message must be non-empty");
    }
    if (!IdempotencyStore.isValidKey(idempotency_key)) {
      throw new BridgeError(
        "invalid_input",
        "idempotency_key must match ^[A-Za-z0-9._-]{1,128}$",
      );
    }

    // Idempotency hit — do not call App Server
    const existing = this.idempotency.get(idempotency_key);
    if (existing) {
      const rec = this.registry.getByTaskId(existing.taskId);
      if (rec) {
        return {
          task_id: rec.taskId,
          thread_id: rec.threadId,
          status: rec.status,
          idempotent_replay: true,
        };
      }
    }

    // Validate project before any App Server traffic
    const realProject = normalizeAndValidateProject(project);

    await this.ensureStarted();

    // thread/start — fields per generated ThreadStartParams
    const startResult = (await this.client.request("thread/start", {
      cwd: realProject,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })) as { thread?: { id?: string } };

    const threadId = startResult?.thread?.id;
    if (!threadId || typeof threadId !== "string") {
      throw new BridgeError(
        "codex_error",
        "thread/start did not return thread.id",
        startResult,
      );
    }

    const rec = this.registry.create(threadId, realProject, "starting");
    this.idempotency.set(idempotency_key, rec.taskId);

    // turn/start under lock
    // UserInput text requires text_elements per generated type
    await this.locks.withThreadLock(threadId, async () => {
      const turnResult = (await this.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: message, text_elements: [] }],
      })) as { turn?: { id?: string } };

      const turnId = turnResult?.turn?.id ?? null;
      this.registry.update(rec.taskId, {
        status: "active",
        currentTurnId: turnId,
      });
    });

    const updated = this.registry.getByTaskId(rec.taskId)!;
    return {
      task_id: updated.taskId,
      thread_id: updated.threadId,
      status: updated.status,
      idempotent_replay: false,
    };
  }

  async continueTask(input: ContinueTaskInput): Promise<ContinueTaskOutput> {
    const { thread_id, message } = input;
    if (!thread_id) {
      throw new BridgeError("invalid_input", "thread_id is required");
    }
    if (!message || message.length < 1) {
      throw new BridgeError("invalid_input", "message must be non-empty");
    }

    await this.ensureStarted();

    // §4.2: resume / turn routing all go through the per-thread lock so concurrent
    // continueTask on an unknown thread_id only issues one thread/resume.
    return this.locks.withThreadLock(thread_id, async () => {
      let fresh = this.registry.getByThreadId(thread_id);
      if (!fresh) {
        const resumeResult = (await this.client.request("thread/resume", {
          threadId: thread_id,
        })) as { thread?: { id?: string; cwd?: string } };

        const project =
          typeof resumeResult?.thread?.cwd === "string"
            ? resumeResult.thread.cwd
            : "/Users/kevin/Documents/aurion";
        fresh = this.registry.registerExisting(thread_id, project, "idle");
      }

      if (fresh.status === "disconnected") {
        throw new BridgeError("disconnected", "task is disconnected");
      }

      const { mode, expectedTurnId } = selectTurnMode(
        fresh.status,
        fresh.currentTurnId,
      );

      try {
        if (mode === "turn_steer") {
          if (!expectedTurnId) {
            throw new BridgeError(
              "conflict",
              "active turn without currentTurnId",
            );
          }
          // expectedTurnId is required by generated TurnSteerParams
          const steerResult = (await this.client.request("turn/steer", {
            threadId: thread_id,
            input: [{ type: "text", text: message, text_elements: [] }],
            expectedTurnId,
          })) as { turnId?: string };

          const turnId = steerResult?.turnId ?? expectedTurnId;
          this.registry.update(fresh.taskId, {
            status: "active",
            currentTurnId: turnId,
          });
          return {
            task_id: fresh.taskId,
            turn_id: turnId,
            mode: "turn_steer" as const,
            accepted: true,
            status: "active",
          };
        }

        // turn_start
        const turnResult = (await this.client.request("turn/start", {
          threadId: thread_id,
          input: [{ type: "text", text: message, text_elements: [] }],
        })) as { turn?: { id?: string } };

        const turnId = turnResult?.turn?.id;
        if (!turnId) {
          throw new BridgeError("codex_error", "turn/start missing turn.id");
        }
        this.registry.update(fresh.taskId, {
          status: "active",
          currentTurnId: turnId,
        });
        return {
          task_id: fresh.taskId,
          turn_id: turnId,
          mode: "turn_start" as const,
          accepted: true,
          status: "active",
        };
      } catch (err) {
        if (mode === "turn_steer" && isBridgeError(err) && err.code === "codex_error") {
          // Steer failed → conflict + latest status; do not retry
          const latest = this.registry.getByTaskId(fresh.taskId)!;
          throw new BridgeError("conflict", err.message, {
            task_id: latest.taskId,
            thread_id: latest.threadId,
            status: latest.status,
            current_turn_id: latest.currentTurnId,
          });
        }
        throw err;
      }
    });
  }

  getStatus(input: GetStatusInput): GetStatusOutput {
    let rec: TaskRecord | undefined;
    if (input.task_id) {
      rec = this.registry.getByTaskId(input.task_id);
    } else if (input.thread_id) {
      rec = this.registry.getByThreadId(input.thread_id);
    } else {
      throw new BridgeError(
        "invalid_input",
        "task_id or thread_id is required",
      );
    }
    if (!rec) {
      throw new BridgeError("invalid_input", "task/thread not found");
    }

    const diag = this.events.diagnostics();
    return {
      task_id: rec.taskId,
      thread_id: rec.threadId,
      status: rec.status,
      current_turn_id: rec.currentTurnId,
      summary: this.events.lastAgentMessage(rec.taskId, 500),
      pending_approvals: this.approvals.listPending(rec.taskId),
      last_error: rec.lastError,
      diagnostics: {
        dropped_events: diag.dropped_events,
        unroutable_notifications: diag.unroutable_notifications,
      },
    };
  }

  readOutput(input: ReadOutputInput): {
    events: ReturnType<EventStore["read"]>["events"];
    next_cursor: number;
    has_more: boolean;
  } {
    const rec = this.registry.getByTaskId(input.task_id);
    if (!rec) {
      throw new BridgeError("invalid_input", `unknown task_id: ${input.task_id}`);
    }
    return this.events.read(input.task_id, input.cursor);
  }

  respondApproval(input: RespondApprovalInput): {
    resolved: boolean;
    request_id: string;
    applied_decision: string;
  } {
    if (input.decision !== "allow" && input.decision !== "deny") {
      throw new BridgeError("invalid_input", "decision must be allow|deny");
    }
    return this.approvals.respondApproval(
      input.request_id,
      input.decision,
      input.note,
    );
  }

  async shutdown(): Promise<void> {
    this.approvals.flushAllDeny("relay shutdown");
    await this.client.shutdown();
    this.started = false;
  }
}

export { BridgeError, isBridgeError } from "./errors.js";
export { PROJECT_ALLOWLIST } from "./thread-registry.js";
