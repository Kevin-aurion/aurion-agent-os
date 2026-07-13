#!/usr/bin/env node
/**
 * Fake Codex app-server for integration tests.
 * Speaks newline-delimited JSON-RPC-like messages on stdio.
 *
 * Wire format matches real codex app-server 0.144.2: messages do **not**
 * include a `jsonrpc` field (presence would hide protocol-tolerance bugs).
 *
 * Env:
 *   FAKE_SCRIPT  — JSON array of scripted behaviors (optional)
 *   FAKE_LOG     — path to append received messages (optional)
 *
 * Default behavior:
 *   initialize → result
 *   thread/start → { thread: { id } }
 *   thread/resume → { thread: { id, cwd } }
 *   turn/start → { turn: { id } }
 *   turn/steer → { turnId } or scripted error
 *
 * Scripted actions (FAKE_SCRIPT JSON):
 *   { "on": "thread/start", "delayMs": 0 }
 *   { "after": "turn/start", "sendRequest": { "method": "...", "params": {} } }
 *   { "after": "turn/start", "sendNotification": { "method": "...", "params": {} } }
 *   { "after": "turn/start", "exit": 1 }
 *   { "on": "turn/steer", "error": { "code": -32000, "message": "conflict" }, "once": true }
 *   { "on": "turn/steer", "nth": 2, "error": {...} }
 *   { "rejectUnknown": true }
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

type ScriptStep = {
  on?: string;
  after?: string;
  delayMs?: number;
  sendRequest?: { method: string; params?: unknown; id?: string | number };
  sendNotification?: { method: string; params?: unknown };
  exit?: number;
  error?: { code: number; message: string };
  once?: boolean;
  nth?: number;
  /** Extra envelope keys on a follow-up message */
  badEnvelope?: Record<string, unknown>;
};

const script: ScriptStep[] = process.env.FAKE_SCRIPT
  ? (JSON.parse(process.env.FAKE_SCRIPT) as ScriptStep[])
  : [];

const logPath = process.env.FAKE_LOG;
const callCounts = new Map<string, number>();
const usedOnce = new Set<number>();
/** Last thread id from thread/start or thread/resume — used to auto-fill ServerRequest params. */
let lastThreadId: string | null = null;

function fillParams(method: string, params: unknown): unknown {
  if (params !== undefined && params !== null) return params;
  const threadId = lastThreadId ?? "thr_unknown";
  switch (method) {
    case "execCommandApproval":
      return {
        conversationId: threadId,
        callId: "call1",
        approvalId: null,
        command: ["ls"],
        cwd: "/Users/kevin/Documents/aurion",
        reason: null,
        parsedCmd: [],
      };
    case "applyPatchApproval":
      return {
        conversationId: threadId,
        callId: "call2",
        reason: null,
      };
    case "item/commandExecution/requestApproval":
      return {
        threadId,
        turnId: "t1",
        itemId: "i1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "echo hi",
      };
    case "item/fileChange/requestApproval":
      return {
        threadId,
        turnId: "t1",
        itemId: "i2",
        startedAtMs: Date.now(),
      };
    case "item/permissions/requestApproval":
      return {
        threadId,
        turnId: "t1",
        itemId: "i3",
        startedAtMs: Date.now(),
      };
    case "item/tool/requestUserInput":
      return {
        threadId,
        turnId: "t1",
        itemId: "i4",
        questions: [],
        autoResolutionMs: null,
      };
    case "mcpServer/elicitation/request":
      return {
        threadId,
        serverName: "test",
        message: "hi",
      };
    case "item/tool/call":
      return {
        threadId,
        turnId: "t1",
        itemId: "i5",
        tool: "x",
        arguments: {},
      };
    case "account/chatgptAuthTokens/refresh":
      return { reason: "test" };
    case "attestation/generate":
      return {};
    case "currentTime/read":
      return {};
    default:
      return { threadId };
  }
}

function logRecv(msg: unknown): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify(msg) + "\n");
  } catch {
    /* ignore */
  }
}

function write(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id: string | number, result: unknown): void {
  // No `jsonrpc` field — matches real app-server 0.144.2 wire format.
  write({ id, result });
}

function respondError(
  id: string | number,
  code: number,
  message: string,
): void {
  write({ id, error: { code, message } });
}

function nextId(): string {
  return `srv_${randomUUID()}`;
}

function countOf(method: string): number {
  return callCounts.get(method) ?? 0;
}

function bump(method: string): number {
  const n = countOf(method) + 1;
  callCounts.set(method, n);
  return n;
}

function findOnHandlers(method: string, n: number): ScriptStep[] {
  return script.filter((s, idx) => {
    if (s.on !== method) return false;
    if (s.once && usedOnce.has(idx)) return false;
    if (s.nth !== undefined && s.nth !== n) return false;
    return true;
  });
}

function findAfterHandlers(method: string): ScriptStep[] {
  return script.filter((s) => s.after === method);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

async function runAfter(method: string): Promise<void> {
  for (const step of findAfterHandlers(method)) {
    if (step.delayMs) await sleep(step.delayMs);
    if (step.sendRequest) {
      const id = step.sendRequest.id ?? nextId();
      write({
        id,
        method: step.sendRequest.method,
        params: fillParams(step.sendRequest.method, step.sendRequest.params),
      });
    }
    if (step.sendNotification) {
      write({
        method: step.sendNotification.method,
        params: step.sendNotification.params ?? {},
      });
    }
    if (step.badEnvelope) {
      write(step.badEnvelope);
    }
    if (typeof step.exit === "number") {
      process.exit(step.exit);
    }
  }
}

function makeThread(id: string, cwd = "/Users/kevin/Documents/aurion") {
  return {
    id,
    sessionId: `sess_${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    recencyAt: null,
    status: "active",
    path: null,
    cwd,
    cliVersion: "0.144.2-fake",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function makeTurn(id: string) {
  return {
    id,
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: null,
    durationMs: null,
  };
}

async function handleRequest(
  id: string | number,
  method: string,
  params: unknown,
): Promise<void> {
  const n = bump(method);
  const onSteps = findOnHandlers(method, n);

  for (let i = 0; i < script.length; i++) {
    const s = script[i]!;
    if (s.on === method && s.once) {
      // mark once steps that match this invocation
      if (findOnHandlers(method, n).includes(s)) usedOnce.add(i);
    }
  }

  for (const step of onSteps) {
    if (step.delayMs) await sleep(step.delayMs);
    if (step.error) {
      respondError(id, step.error.code, step.error.message);
      await runAfter(method);
      return;
    }
  }

  switch (method) {
    case "initialize":
      respond(id, {
        userAgent: "fake-app-server/0.0.1",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      });
      break;
    case "thread/start": {
      const p = (params ?? {}) as { cwd?: string };
      const tid = `thr_${randomUUID()}`;
      lastThreadId = tid;
      respond(id, {
        thread: makeThread(tid, p.cwd ?? "/Users/kevin/Documents/aurion"),
        model: "gpt-5",
        modelProvider: "openai",
        serviceTier: null,
        cwd: p.cwd ?? "/Users/kevin/Documents/aurion",
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: null,
      });
      break;
    }
    case "thread/resume": {
      const p = (params ?? {}) as { threadId?: string };
      const tid = p.threadId ?? `thr_${randomUUID()}`;
      lastThreadId = tid;
      respond(id, {
        thread: makeThread(tid),
        model: "gpt-5",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/Users/kevin/Documents/aurion",
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: null,
      });
      break;
    }
    case "turn/start": {
      const p = (params ?? {}) as { threadId?: string };
      const turnId = `turn_${randomUUID()}`;
      respond(id, { turn: makeTurn(turnId) });
      // Also emit turn/started notification (no jsonrpc — real wire format)
      write({
        method: "turn/started",
        params: {
          threadId: p.threadId,
          turn: makeTurn(turnId),
        },
      });
      break;
    }
    case "turn/steer": {
      const p = (params ?? {}) as {
        threadId?: string;
        expectedTurnId?: string;
      };
      const turnId = p.expectedTurnId ?? `turn_${randomUUID()}`;
      respond(id, { turnId });
      break;
    }
    case "turn/interrupt": {
      respond(id, {});
      break;
    }
    case "thread/list": {
      respond(id, { threads: [], nextCursor: null });
      break;
    }
    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }

  await runAfter(method);
}

// Track responses we receive (approval decisions etc.)
const receivedResponses: unknown[] = [];
if (process.env.FAKE_RESPONSE_LOG) {
  // keep in memory; parent can also use FAKE_LOG which logs everything both ways? we only log inbound
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    logRecv(msg);

    // Response to our ServerRequest (approval decisions)
    if ("id" in msg && ("result" in msg || "error" in msg) && !("method" in msg)) {
      receivedResponses.push(msg);
      if (process.env.FAKE_RESPONSE_LOG) {
        try {
          appendFileSync(
            process.env.FAKE_RESPONSE_LOG,
            JSON.stringify(msg) + "\n",
          );
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    // Notification (e.g. initialized)
    if (!("id" in msg) && typeof msg.method === "string") {
      // no-op
      continue;
    }

    // Request from client
    if ("id" in msg && typeof msg.method === "string") {
      void handleRequest(
        msg.id as string | number,
        msg.method,
        msg.params,
      );
    }
  }
});

// Ready marker on stderr (not protocol)
process.stderr.write("[fake-app-server] ready\n");

// Keep alive
process.stdin.on("end", () => {
  process.exit(0);
});

// Touch writeFileSync so tree-shakers keep import (used when clearing logs)
void writeFileSync;
