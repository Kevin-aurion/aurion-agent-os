import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AURION_PROJECT,
  createTestRelay,
  readJsonLinesAsync,
  waitFor,
} from "../helpers/spawn-bridge.js";
import { BridgeError } from "../../src/relay-core/index.js";

const QUEUE_KINDS = [
  "execCommandApproval",
  "applyPatchApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
] as const;

const IMMEDIATE_ERROR_KINDS = [
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
] as const;

function defaultParams(method: string, threadId: string): unknown {
  switch (method) {
    case "execCommandApproval":
      return {
        conversationId: threadId,
        callId: "call1",
        approvalId: null,
        command: ["ls"],
        cwd: AURION_PROJECT,
        reason: null,
        parsedCmd: [],
      };
    case "applyPatchApproval":
      return {
        conversationId: threadId,
        callId: "call2",
        fileChanges: {},
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
        requestedSchema: null,
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

describe("approval-fail-closed", () => {
  it("11 ServerRequest kinds: queue, timeout deny shapes, immediate errors, auto time, respond paths", async () => {
    // (a)+(b) each queue kind: appears in pending_approvals; timeout deny shape
    for (const kind of QUEUE_KINDS) {
      const respLog = path.join(
        os.tmpdir(),
        `crb-to-${kind.replace(/\//g, "_")}-${Date.now()}.log`,
      );
      if (fs.existsSync(respLog)) fs.unlinkSync(respLog);

      const relay = createTestRelay({
        approvalTimeoutMs: 200,
        fakeResponseLog: respLog,
        fakeScript: [
          {
            after: "turn/start",
            delayMs: 30,
            sendRequest: {
              method: kind,
              // params omitted → fake fills with last thread id
            },
          },
        ],
      });

      try {
        const started = await relay.startTask({
          project: AURION_PROJECT,
          message: `test ${kind}`,
          idempotency_key: `key-appr-${kind.replace(/\//g, "_")}-${Date.now()}`,
        });

        await waitFor(() => {
          const st = relay.getStatus({ task_id: started.task_id });
          return st.pending_approvals.some((a) => a.kind === kind);
        }, 2000);

        const st = relay.getStatus({ task_id: started.task_id });
        const pending = st.pending_approvals.find((a) => a.kind === kind);
        assert.ok(pending, `${kind} in pending_approvals`);
        assert.equal(pending.kind, kind);

        // Wait for timeout (200ms + margin)
        await waitFor(async () => {
          const lines = await readJsonLinesAsync(respLog);
          return lines.some((l) => "result" in l || "error" in l);
        }, 3000);

        const lines = await readJsonLinesAsync(respLog);
        assert.ok(lines.length >= 1, `${kind}: timeout response received by fake`);
        const resp = lines[lines.length - 1]!;

        assertDenyShape(kind, resp, "timeout");
      } finally {
        await relay.shutdown();
      }
    }

    // (c) #9 #10 immediate error -32601, not in queue
    for (const kind of IMMEDIATE_ERROR_KINDS) {
      const respLog = path.join(
        os.tmpdir(),
        `crb-imm-${kind.replace(/\//g, "_")}-${Date.now()}.log`,
      );
      if (fs.existsSync(respLog)) fs.unlinkSync(respLog);

      const relay = createTestRelay({
        fakeResponseLog: respLog,
        fakeScript: [
          {
            after: "turn/start",
            delayMs: 20,
            sendRequest: { method: kind },
          },
        ],
      });
      try {
        const started = await relay.startTask({
          project: AURION_PROJECT,
          message: `imm ${kind}`,
          idempotency_key: `key-imm-${kind.replace(/\//g, "_")}-${Date.now()}`,
        });

        await waitFor(async () => {
          const lines = await readJsonLinesAsync(respLog);
          return lines.length > 0;
        }, 2000);

        const st = relay.getStatus({ task_id: started.task_id });
        assert.equal(
          st.pending_approvals.filter((a) => a.kind === kind).length,
          0,
          `${kind} must not enter approval queue`,
        );

        const lines = await readJsonLinesAsync(respLog);
        const err = lines.find((l) => l.error);
        assert.ok(err, `${kind} error response`);
        const e = err.error as { code: number; message: string };
        assert.equal(e.code, -32601);
        assert.match(e.message, /not supported/i);
      } finally {
        await relay.shutdown();
      }
    }

    // (d) #11 currentTime/read immediate currentTimeAt integer seconds
    {
      const respLog = path.join(os.tmpdir(), `crb-time-${Date.now()}.log`);
      if (fs.existsSync(respLog)) fs.unlinkSync(respLog);
      const relay = createTestRelay({
        fakeResponseLog: respLog,
        fakeScript: [
          {
            after: "turn/start",
            delayMs: 20,
            sendRequest: { method: "currentTime/read" },
          },
        ],
      });
      try {
        await relay.startTask({
          project: AURION_PROJECT,
          message: "time",
          idempotency_key: `key-time-${Date.now()}`,
        });
        await waitFor(async () => {
          const lines = await readJsonLinesAsync(respLog);
          return lines.some((l) => l.result);
        }, 2000);
        const lines = await readJsonLinesAsync(respLog);
        const ok = lines.find((l) => l.result);
        assert.ok(ok);
        const result = ok.result as { currentTimeAt: number };
        assert.equal(typeof result.currentTimeAt, "number");
        assert.ok(Number.isInteger(result.currentTimeAt));
        // seconds, not ms
        assert.ok(result.currentTimeAt < 1e12);
      } finally {
        await relay.shutdown();
      }
    }

    // (e) respond deny on #3 → { decision: "decline" }
    {
      const respLog = path.join(os.tmpdir(), `crb-deny3-${Date.now()}.log`);
      if (fs.existsSync(respLog)) fs.unlinkSync(respLog);
      const relay = createTestRelay({
        approvalTimeoutMs: 30_000,
        fakeResponseLog: respLog,
        fakeScript: [
          {
            after: "turn/start",
            delayMs: 20,
            sendRequest: {
              method: "item/commandExecution/requestApproval",
            },
          },
        ],
      });
      try {
        const started = await relay.startTask({
          project: AURION_PROJECT,
          message: "deny3",
          idempotency_key: `key-deny3-${Date.now()}`,
        });
        await waitFor(() => {
          return (
            relay.getStatus({ task_id: started.task_id }).pending_approvals
              .length > 0
          );
        }, 2000);
        const appr =
          relay.getStatus({ task_id: started.task_id }).pending_approvals[0]!;
        const out = relay.respondApproval({
          request_id: appr.request_id,
          decision: "deny",
        });
        assert.equal(out.resolved, true);
        assert.equal(out.applied_decision, "deny");

        await waitFor(async () => {
          const lines = await readJsonLinesAsync(respLog);
          return lines.some((l) => l.result);
        }, 2000);
        const lines = await readJsonLinesAsync(respLog);
        const resp = lines.find((l) => l.result)!;
        assert.deepEqual(resp.result, { decision: "decline" });
      } finally {
        await relay.shutdown();
      }
    }

    // (f) allow on #5 permissions still rejected (not_supported)
    {
      const respLog = path.join(os.tmpdir(), `crb-allow5-${Date.now()}.log`);
      if (fs.existsSync(respLog)) fs.unlinkSync(respLog);
      const relay = createTestRelay({
        approvalTimeoutMs: 30_000,
        fakeResponseLog: respLog,
        fakeScript: [
          {
            after: "turn/start",
            delayMs: 20,
            sendRequest: { method: "item/permissions/requestApproval" },
          },
        ],
      });
      try {
        const started = await relay.startTask({
          project: AURION_PROJECT,
          message: "allow5",
          idempotency_key: `key-allow5-${Date.now()}`,
        });
        await waitFor(() => {
          return (
            relay.getStatus({ task_id: started.task_id }).pending_approvals
              .length > 0
          );
        }, 2000);
        const appr =
          relay.getStatus({ task_id: started.task_id }).pending_approvals[0]!;
        await assert.rejects(
          async () =>
            relay.respondApproval({
              request_id: appr.request_id,
              decision: "allow",
            }),
          (err: unknown) => {
            assert.ok(err instanceof BridgeError);
            assert.equal(err.code, "not_supported");
            return true;
          },
        );
        // Still sent fail-closed deny error to app-server
        await waitFor(async () => {
          const lines = await readJsonLinesAsync(respLog);
          return lines.some((l) => l.error);
        }, 2000);
        const lines = await readJsonLinesAsync(respLog);
        const err = lines.find((l) => l.error)!;
        assert.equal((err.error as { code: number }).code, -32001);
      } finally {
        await relay.shutdown();
      }
    }

    // Also cover #8 item/tool/call immediate dynamic tool response
    {
      const respLog = path.join(os.tmpdir(), `crb-dyn-${Date.now()}.log`);
      if (fs.existsSync(respLog)) fs.unlinkSync(respLog);
      const relay = createTestRelay({
        fakeResponseLog: respLog,
        fakeScript: [
          {
            after: "turn/start",
            delayMs: 20,
            sendRequest: { method: "item/tool/call" },
          },
        ],
      });
      try {
        const started = await relay.startTask({
          project: AURION_PROJECT,
          message: "dyn",
          idempotency_key: `key-dyn-${Date.now()}`,
        });
        await waitFor(async () => {
          const lines = await readJsonLinesAsync(respLog);
          return lines.some((l) => l.result);
        }, 2000);
        const st = relay.getStatus({ task_id: started.task_id });
        assert.equal(
          st.pending_approvals.filter((a) => a.kind === "item/tool/call")
            .length,
          0,
        );
        const lines = await readJsonLinesAsync(respLog);
        const resp = lines.find((l) => l.result)!;
        const result = resp.result as {
          success: boolean;
          contentItems: Array<{ type: string; text: string }>;
        };
        assert.equal(result.success, false);
        assert.equal(result.contentItems[0]?.type, "inputText");
        assert.match(result.contentItems[0]!.text, /no dynamic tools/);
      } finally {
        await relay.shutdown();
      }
    }
  });
});

function assertDenyShape(
  kind: string,
  resp: Record<string, unknown>,
  mode: "timeout" | "deny",
): void {
  switch (kind) {
    case "execCommandApproval":
    case "applyPatchApproval": {
      const decision =
        mode === "timeout" ? "timed_out" : "denied";
      // timeout path uses timed_out; our resolveInternal timeout uses timed_out
      assert.deepEqual(resp.result, { decision });
      break;
    }
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      assert.deepEqual(resp.result, { decision: "decline" });
      break;
    }
    case "item/permissions/requestApproval":
    case "item/tool/requestUserInput": {
      const e = resp.error as { code: number; message: string };
      assert.equal(e.code, -32001);
      assert.match(e.message, /fail-closed|denied/i);
      break;
    }
    case "mcpServer/elicitation/request": {
      assert.deepEqual(resp.result, {
        action: "decline",
        content: null,
        _meta: null,
      });
      break;
    }
    default:
      assert.fail(`unexpected kind ${kind}`);
  }
}

// silence unused defaultParams (kept for documentation)
void defaultParams;
