import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError } from "./errors.js";

// TODO(phase2): SQLite

export type TaskStatus =
  | "starting"
  | "idle"
  | "active"
  | "interrupted"
  | "failed"
  | "disconnected";

export interface TaskRecord {
  taskId: string;
  threadId: string;
  project: string;
  status: TaskStatus;
  currentTurnId: string | null;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

/**
 * Project path allowlist (realpath prefix match).
 * From `CODEX_BRIDGE_ALLOWLIST` (colon-separated absolute paths).
 * Unset/empty → default `["/"]` (allow any absolute path on this machine).
 */
export function getProjectAllowlist(): string[] {
  const raw = process.env.CODEX_BRIDGE_ALLOWLIST;
  if (raw === undefined || raw === "") {
    return ["/"];
  }
  return raw.split(":").filter((p) => p.length > 0);
}

/** @deprecated Prefer getProjectAllowlist(); re-exported name for public API. */
export const PROJECT_ALLOWLIST = getProjectAllowlist;

/** True if `real` (already realpath'd absolute path) matches allowlist prefix rules. */
function isProjectAllowed(real: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    // Strip trailing slashes so "/foo/" and "/foo" match the same.
    // Root "/" becomes "" → treat as allow any absolute path.
    const normalized = prefix.replace(/\/+$/, "");
    if (normalized === "") {
      return true;
    }
    return real === normalized || real.startsWith(normalized + path.sep);
  });
}

export function normalizeAndValidateProject(project: string): string {
  if (typeof project !== "string" || project.length === 0) {
    throw new BridgeError("invalid_input", "project must be a non-empty absolute path");
  }
  if (!path.isAbsolute(project)) {
    throw new BridgeError("invalid_input", "project must be an absolute path");
  }
  let real: string;
  try {
    real = fs.realpathSync(project);
  } catch (err) {
    throw new BridgeError(
      "invalid_input",
      `project path does not exist or is not accessible: ${project}`,
      err,
    );
  }
  const allowed = isProjectAllowed(real, getProjectAllowlist());
  if (!allowed) {
    throw new BridgeError(
      "invalid_input",
      `project path not in allowlist after realpath: ${real}`,
    );
  }
  return real;
}

export class ThreadRegistry {
  private readonly byTaskId = new Map<string, TaskRecord>();
  private readonly byThreadId = new Map<string, string>(); // threadId -> taskId

  create(threadId: string, project: string, status: TaskStatus = "starting"): TaskRecord {
    const now = Date.now();
    const taskId = `task_${randomUUID()}`;
    const rec: TaskRecord = {
      taskId,
      threadId,
      project,
      status,
      currentTurnId: null,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    this.byTaskId.set(taskId, rec);
    this.byThreadId.set(threadId, taskId);
    return rec;
  }

  /** Register an existing thread (e.g. after resume of unknown thread). */
  registerExisting(
    threadId: string,
    project: string,
    status: TaskStatus = "idle",
  ): TaskRecord {
    const existing = this.getByThreadId(threadId);
    if (existing) return existing;
    return this.create(threadId, project, status);
  }

  getByTaskId(taskId: string): TaskRecord | undefined {
    return this.byTaskId.get(taskId);
  }

  getByThreadId(threadId: string): TaskRecord | undefined {
    const taskId = this.byThreadId.get(threadId);
    if (!taskId) return undefined;
    return this.byTaskId.get(taskId);
  }

  update(taskId: string, patch: Partial<Omit<TaskRecord, "taskId" | "createdAt">>): TaskRecord {
    const rec = this.byTaskId.get(taskId);
    if (!rec) {
      throw new BridgeError("invalid_input", `unknown task_id: ${taskId}`);
    }
    if (patch.threadId && patch.threadId !== rec.threadId) {
      this.byThreadId.delete(rec.threadId);
      this.byThreadId.set(patch.threadId, taskId);
    }
    Object.assign(rec, patch, { updatedAt: Date.now() });
    return rec;
  }

  markAllDisconnected(error: string): void {
    for (const rec of this.byTaskId.values()) {
      if (rec.status !== "disconnected") {
        rec.status = "disconnected";
        rec.lastError = error;
        rec.updatedAt = Date.now();
      }
    }
  }

  list(): TaskRecord[] {
    return [...this.byTaskId.values()];
  }
}
