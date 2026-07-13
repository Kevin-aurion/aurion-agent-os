/**
 * Approval / ServerRequest handling — fail-closed by design.
 *
 * Decision literals and error shapes follow generated types where they exist.
 * Protocol discrepancies vs the Phase 1 plan table are annotated in comments.
 */

import { randomUUID } from "node:crypto";
import type { AppServerClient } from "./app-server-client.js";
import type { JsonRpcId } from "./rpc-types.js";
import { BridgeError } from "./errors.js";
import type { EventStore } from "./event-store.js";
import type { ThreadRegistry } from "./thread-registry.js";

export type ApprovalKind =
  | "execCommandApproval"
  | "applyPatchApproval"
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request"
  | "item/tool/call"
  | "account/chatgptAuthTokens/refresh"
  | "attestation/generate"
  | "currentTime/read";

export interface PendingApproval {
  requestId: string; // appr_<uuid> — bridge-facing id
  rpcId: JsonRpcId; // original JSON-RPC id for the ServerRequest
  method: ApprovalKind;
  threadId: string | null;
  taskId: string | null;
  summary: string;
  expiresAt: number;
  params: unknown;
  /** If false, human "allow" is rejected (high-risk / NEVER auto-allow). */
  allowable: boolean;
  timer: NodeJS.Timeout;
}

export interface ApprovalsOptions {
  client: AppServerClient;
  events: EventStore;
  registry: ThreadRegistry;
  /** Approval timeout (default 120s). Tests may set 200ms. */
  approvalTimeoutMs?: number;
  resolveTaskId?: (threadId: string | null) => string | null;
}

function summaryFor(method: string, params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "execCommandApproval": {
      const cmd = Array.isArray(p.command) ? (p.command as string[]).join(" ") : "";
      return `exec: ${cmd}`.slice(0, 200);
    }
    case "applyPatchApproval":
      return "applyPatchApproval";
    case "item/commandExecution/requestApproval":
      return `command: ${String(p.command ?? "")}`.slice(0, 200);
    case "item/fileChange/requestApproval":
      return "fileChange approval";
    case "item/permissions/requestApproval":
      return "permissions approval";
    case "item/tool/requestUserInput":
      return "tool user input";
    case "mcpServer/elicitation/request":
      return "mcp elicitation";
    default:
      return method;
  }
}

function extractThreadId(method: string, params: unknown): string | null {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.threadId === "string") return p.threadId;
  if (typeof p.conversationId === "string") return p.conversationId;
  return null;
}

export class ApprovalsManager {
  private readonly client: AppServerClient;
  private readonly events: EventStore;
  private readonly registry: ThreadRegistry;
  private readonly approvalTimeoutMs: number;
  private readonly resolveTaskId: (threadId: string | null) => string | null;
  private readonly pending = new Map<string, PendingApproval>();
  private closed = false;

  constructor(opts: ApprovalsOptions) {
    this.client = opts.client;
    this.events = opts.events;
    this.registry = opts.registry;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 120_000;
    this.resolveTaskId =
      opts.resolveTaskId ??
      ((threadId) => {
        if (!threadId) return null;
        return this.registry.getByThreadId(threadId)?.taskId ?? null;
      });
  }

  listPending(taskId?: string): Array<{
    request_id: string;
    kind: string;
    summary: string;
    expires_at: number;
  }> {
    const out: Array<{
      request_id: string;
      kind: string;
      summary: string;
      expires_at: number;
    }> = [];
    for (const a of this.pending.values()) {
      if (taskId && a.taskId !== taskId) continue;
      out.push({
        request_id: a.requestId,
        kind: a.method,
        summary: a.summary,
        expires_at: a.expiresAt,
      });
    }
    return out;
  }

  /**
   * Handle an inbound ServerRequest from app-server.
   * Fail-closed default for unknown methods is done by the client layer (-32601).
   */
  handleServerRequest(req: {
    id: JsonRpcId;
    method: string;
    params: unknown;
  }): void {
    if (this.closed) {
      this.failClosedImmediate(req.id, req.method, req.params, "bridge closed");
      return;
    }

    switch (req.method) {
      // #1 legacy exec
      case "execCommandApproval":
        this.enqueue(req.id, "execCommandApproval", req.params, true);
        break;
      // #2 legacy patch
      case "applyPatchApproval":
        this.enqueue(req.id, "applyPatchApproval", req.params, true);
        break;
      // #3
      case "item/commandExecution/requestApproval":
        this.enqueue(req.id, "item/commandExecution/requestApproval", req.params, true);
        break;
      // #4
      case "item/fileChange/requestApproval":
        this.enqueue(req.id, "item/fileChange/requestApproval", req.params, true);
        break;
      // #5 permissions — Phase1 never allow (absolute NEVER auto-allow)
      case "item/permissions/requestApproval":
        this.enqueue(req.id, "item/permissions/requestApproval", req.params, false);
        break;
      // #6 user input — Phase1 only deny (allow → not_supported)
      case "item/tool/requestUserInput":
        this.enqueue(req.id, "item/tool/requestUserInput", req.params, false);
        break;
      // #7 elicitation — Phase1 only deny
      case "mcpServer/elicitation/request":
        this.enqueue(req.id, "mcpServer/elicitation/request", req.params, false);
        break;
      // #8 dynamic tool — immediate fail-closed, no queue
      case "item/tool/call":
        this.respondDynamicToolCall(req.id, req.params);
        break;
      // #9 auth refresh — immediate -32601
      case "account/chatgptAuthTokens/refresh":
        this.client.respondError(
          req.id,
          -32601,
          "not supported by this client",
        );
        this.emitImmediateEvent(req.method, req.params, "error", "auth tokens refresh not supported");
        break;
      // #10 attestation — immediate -32601
      case "attestation/generate":
        this.client.respondError(
          req.id,
          -32601,
          "not supported by this client",
        );
        this.emitImmediateEvent(req.method, req.params, "error", "attestation not supported");
        break;
      // #11 currentTime/read — auto reply
      // NOTE: not present in generated ServerRequest for 0.144.2; kept for plan/tests.
      case "currentTime/read":
        this.client.respond(req.id, {
          currentTimeAt: Math.floor(Date.now() / 1000),
        });
        console.error("[approvals] auto-replied currentTime/read");
        break;
      default:
        // Fail-closed for anything unexpected that slipped past the client filter
        this.client.respondError(req.id, -32601, `Method not found: ${req.method}`);
        this.emitImmediateEvent(
          req.method,
          req.params,
          "protocol_violation",
          `unknown ServerRequest: ${req.method}`,
        );
        break;
    }
  }

  private enqueue(
    rpcId: JsonRpcId,
    method: ApprovalKind,
    params: unknown,
    allowable: boolean,
  ): void {
    const requestId = `appr_${randomUUID()}`;
    const threadId = extractThreadId(method, params);
    const taskId = this.resolveTaskId(threadId);
    const expiresAt = Date.now() + this.approvalTimeoutMs;

    const timer = setTimeout(() => {
      this.resolveInternal(requestId, "timeout", "timeout");
    }, this.approvalTimeoutMs);

    const pending: PendingApproval = {
      requestId,
      rpcId,
      method,
      threadId,
      taskId,
      summary: summaryFor(method, params),
      expiresAt,
      params,
      allowable,
      timer,
    };
    this.pending.set(requestId, pending);

    if (taskId) {
      this.events.append(taskId, {
        type: "approval_requested",
        requestId,
        kind: method,
        text: pending.summary,
        raw: params,
      });
    }

    console.error(
      `[approvals] queued ${method} request_id=${requestId} timeout=${this.approvalTimeoutMs}ms`,
    );
  }

  /**
   * Human response via MCP tool codex_respond_approval.
   * decision: "allow" | "deny"
   */
  respondApproval(
    requestId: string,
    decision: "allow" | "deny",
    _note?: string,
  ): { resolved: boolean; request_id: string; applied_decision: string } {
    const pending = this.pending.get(requestId);
    if (!pending) {
      throw new BridgeError("invalid_input", `unknown or already resolved request_id: ${requestId}`);
    }

    if (decision === "allow") {
      if (!pending.allowable) {
        // High-risk / Phase1 not_supported kinds: still deny even if user says allow
        this.resolveInternal(requestId, "deny", "not_supported");
        throw new BridgeError(
          "not_supported",
          `allow not supported for ${pending.method} in Phase 1 (fail-closed)`,
        );
      }
      this.resolveInternal(requestId, "allow", "allow");
      return {
        resolved: true,
        request_id: requestId,
        applied_decision: "allow",
      };
    }

    this.resolveInternal(requestId, "deny", "deny");
    return {
      resolved: true,
      request_id: requestId,
      applied_decision: "deny",
    };
  }

  private resolveInternal(
    requestId: string,
    outcome: "allow" | "deny" | "timeout",
    appliedLabel: string,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    this.sendDecision(pending, outcome);

    if (pending.taskId) {
      this.events.append(pending.taskId, {
        type: "approval_resolved",
        requestId,
        kind: pending.method,
        decision: appliedLabel,
      });
    }
  }

  /**
   * Send the JSON-RPC response body for each kind.
   * Decision literals follow generated types.
   */
  private sendDecision(
    pending: PendingApproval,
    outcome: "allow" | "deny" | "timeout",
  ): void {
    const { rpcId, method } = pending;

    switch (method) {
      case "execCommandApproval":
      case "applyPatchApproval": {
        // ReviewDecision: "approved" | "denied" | "timed_out" | ...
        let decision: string;
        if (outcome === "allow") decision = "approved";
        else if (outcome === "timeout") decision = "timed_out";
        else decision = "denied";
        this.client.respond(rpcId, { decision });
        break;
      }
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        // CommandExecutionApprovalDecision / FileChangeApprovalDecision: "accept" | "decline" | ...
        const decision = outcome === "allow" ? "accept" : "decline";
        this.client.respond(rpcId, { decision });
        break;
      }
      case "item/permissions/requestApproval": {
        // Generated PermissionsRequestApprovalResponse has no decline field;
        // plan: JSON-RPC error -32001 for deny/timeout. Phase1 never allow.
        this.client.respondError(
          rpcId,
          -32001,
          "denied by relay bridge (fail-closed)",
        );
        break;
      }
      case "item/tool/requestUserInput": {
        // Never invent answers; deny via JSON-RPC error
        this.client.respondError(
          rpcId,
          -32001,
          "denied by relay bridge (fail-closed)",
        );
        break;
      }
      case "mcpServer/elicitation/request": {
        // McpServerElicitationRequestResponse
        this.client.respond(rpcId, {
          action: "decline",
          content: null,
          _meta: null,
        });
        break;
      }
      default:
        this.client.respondError(
          rpcId,
          -32001,
          "denied by relay bridge (fail-closed)",
        );
    }
  }

  private respondDynamicToolCall(id: JsonRpcId, params: unknown): void {
    // DynamicToolCallResponse: contentItems + success
    // DynamicToolCallOutputContentItem: { type: "inputText", text: string }
    this.client.respond(id, {
      contentItems: [
        {
          type: "inputText",
          text: "relay bridge has no dynamic tools",
        },
      ],
      success: false,
    });
    this.emitImmediateEvent(
      "item/tool/call",
      params,
      "error",
      "dynamic tool call rejected",
    );
  }

  private emitImmediateEvent(
    method: string,
    params: unknown,
    type: "error" | "protocol_violation",
    text: string,
  ): void {
    const threadId = extractThreadId(method, params);
    const taskId = this.resolveTaskId(threadId);
    if (taskId) {
      this.events.append(taskId, { type, text, kind: method, raw: params });
    } else {
      // Attach to first task if any, else drop with unroutable counter via events
      const all = this.registry.list();
      if (all[0]) {
        this.events.append(all[0].taskId, { type, text, kind: method, raw: params });
      }
    }
  }

  private failClosedImmediate(
    id: JsonRpcId,
    method: string,
    params: unknown,
    reason: string,
  ): void {
    this.client.respondError(id, -32001, `denied by relay bridge (fail-closed): ${reason}`);
    this.emitImmediateEvent(method, params, "error", reason);
  }

  /**
   * Flush all pending approvals as deny (best-effort) before process exit.
   * Called on SIGTERM / shutdown.
   */
  flushAllDeny(reason = "bridge shutdown"): void {
    this.closed = true;
    const ids = [...this.pending.keys()];
    for (const id of ids) {
      try {
        this.resolveInternal(id, "deny", reason);
      } catch (err) {
        console.error("[approvals] flush error:", err);
      }
    }
  }

  /** Mark all pending as resolved(denied) without RPC (app-server already gone). */
  markAllDeniedLocal(reason = "app-server disconnected"): void {
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.taskId) {
        this.events.append(pending.taskId, {
          type: "approval_resolved",
          requestId,
          kind: pending.method,
          decision: "denied",
          text: reason,
        });
      }
    }
    this.pending.clear();
  }
}
