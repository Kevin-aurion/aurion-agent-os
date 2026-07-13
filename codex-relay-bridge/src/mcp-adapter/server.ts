/**
 * MCP stdio server wiring RelayCore tools.
 * Logs only go to stderr; stdout is the MCP channel.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  RelayCore,
  BridgeError,
  isBridgeError,
  type RelayCoreOptions,
} from "../relay-core/index.js";
import { toolDefinitions, validateToolInput } from "./tool-schemas.js";

function log(...args: unknown[]): void {
  console.error("[mcp-adapter]", ...args);
}

function errorResult(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  if (isBridgeError(err)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(err.toJSON()),
        },
      ],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "internal", message }),
      },
    ],
    isError: true,
  };
}

function okResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

export function createMcpServer(relay: RelayCore): Server {
  const server = new Server(
    {
      name: "codex-relay-bridge",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as unknown as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};

    const validation = validateToolInput(name, args);
    if (!validation.ok) {
      return errorResult(
        new BridgeError("invalid_input", validation.error ?? "invalid input"),
      );
    }
    const v = validation.value!;

    try {
      switch (name) {
        case "codex_start_task":
          return okResult(
            await relay.startTask({
              project: v.project as string,
              message: v.message as string,
              idempotency_key: v.idempotency_key as string,
            }),
          );
        case "codex_continue_task":
          return okResult(
            await relay.continueTask({
              thread_id: v.thread_id as string,
              message: v.message as string,
            }),
          );
        case "codex_get_status":
          return okResult(
            relay.getStatus({
              ...(typeof v.task_id === "string" ? { task_id: v.task_id } : {}),
              ...(typeof v.thread_id === "string"
                ? { thread_id: v.thread_id }
                : {}),
            }),
          );
        case "codex_read_output":
          return okResult(
            relay.readOutput({
              task_id: v.task_id as string,
              ...(typeof v.cursor === "number" ? { cursor: v.cursor } : {}),
            }),
          );
        case "codex_respond_approval":
          return okResult(
            relay.respondApproval({
              request_id: v.request_id as string,
              decision: v.decision as "allow" | "deny",
              ...(typeof v.note === "string" ? { note: v.note } : {}),
            }),
          );
        default:
          return errorResult(
            new BridgeError("invalid_input", `unknown tool: ${name}`),
          );
      }
    } catch (err) {
      log("tool error:", name, err);
      return errorResult(err);
    }
  });

  return server;
}

export async function runMcpStdio(opts: RelayCoreOptions = {}): Promise<void> {
  const relay = new RelayCore(opts);
  relay.installSignalHandlers();

  // MCP initialize / tools/list must not wait on app-server handshake.
  // Connect MCP immediately; warm app-server in the background. Tool handlers
  // call ensureStarted and return a clear error if the child is not ready.
  void relay.start().catch((err) => {
    log("warning: background app-server start failed (degraded):", err);
  });

  const server = createMcpServer(relay);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP stdio server running");
}
