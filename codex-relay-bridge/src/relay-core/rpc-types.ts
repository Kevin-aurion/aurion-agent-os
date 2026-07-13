/**
 * JSON-RPC 2.0 framing types used by the App Server client.
 * Protocol method/param shapes come from src/generated/.
 */

export type JsonRpcId = string | number;

/**
 * Outgoing client messages may include `jsonrpc: "2.0"` (real app-server accepts it).
 * Incoming app-server messages often **omit** `jsonrpc` entirely (codex-cli 0.144.2).
 */
export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc?: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcError;

/**
 * Known envelope keys. `jsonrpc` is optional on the wire for real app-server;
 * presence/value must never cause reject.
 */
export const JSONRPC_ENVELOPE_KEYS = new Set([
  "jsonrpc",
  "id",
  "method",
  "params",
  "result",
  "error",
]);

/**
 * Known ServerRequest method literals from generated ServerRequest union
 * (codex-cli 0.144.2). currentTime/read is NOT present in generated types;
 * handled as a documented special-case for plan compatibility.
 */
export const KNOWN_SERVER_REQUEST_METHODS = new Set<string>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "applyPatchApproval",
  "execCommandApproval",
  // Plan special-case: not in generated ServerRequest for 0.144.2
  "currentTime/read",
]);

/** Known ServerNotification method literals from generated ServerNotification union. */
export const KNOWN_SERVER_NOTIFICATION_METHODS = new Set<string>([
  "error",
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/deleted",
  "thread/unarchived",
  "thread/closed",
  "skills/changed",
  "thread/name/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/settings/updated",
  "thread/tokenUsage/updated",
  "turn/started",
  "hook/started",
  "turn/completed",
  "hook/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "item/completed",
  "rawResponseItem/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/commandExecution/terminalInteraction",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "turn/moderationMetadata",
  "serverRequest/resolved",
  "command/exec/outputDelta",
  "process/outputDelta",
  "process/exited",
  "fs/changed",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "account/updated",
  "account/login/completed",
  "account/rateLimits/updated",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "app/list/updated",
  "configWarning",
  "deprecationNotice",
  "error",
  "warning",
  "guardianWarning",
  "model/rerouted",
  "model/safetyBuffering/updated",
  "model/verification",
  "remoteControl/status/changed",
  "thread/compacted",
  "thread/realtime/started",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/itemAdded",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "windowsSandbox/setupCompleted",
  "windows/worldWritableWarning",
  "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed",
]);

export type EnvelopeKind =
  | "server_request"
  | "response"
  | "server_notification"
  | "invalid";

export function classifyEnvelope(msg: Record<string, unknown>): {
  kind: EnvelopeKind;
  reason?: string;
} {
  for (const key of Object.keys(msg)) {
    if (!JSONRPC_ENVELOPE_KEYS.has(key)) {
      return { kind: "invalid", reason: `unknown envelope key: ${key}` };
    }
  }

  // Do NOT require msg.jsonrpc === "2.0". Real codex app-server 0.144.2 omits
  // the field on responses and notifications; rejecting on that breaks handshake.

  const hasId = "id" in msg;
  const hasMethod = typeof msg.method === "string";
  const hasResult = "result" in msg;
  const hasError = "error" in msg;

  if (hasId && hasMethod && !hasResult && !hasError) {
    return { kind: "server_request" };
  }
  if (hasId && (hasResult || hasError) && !hasMethod) {
    return { kind: "response" };
  }
  if (!hasId && hasMethod && !hasResult && !hasError) {
    return { kind: "server_notification" };
  }
  return {
    kind: "invalid",
    reason: "unrecognized JSON-RPC envelope shape",
  };
}
