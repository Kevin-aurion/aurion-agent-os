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

describe("crash-during-approval", () => {
  it("bridge SIGTERM during approval → fake receives denied; reverse: fake exit → disconnected", async () => {
    // ── Direction A: bridge flush on shutdown while approval pending ──
    {
      const respLog = path.join(os.tmpdir(), `crb-crash-a-${Date.now()}.log`);
      if (fs.existsSync(respLog)) fs.unlinkSync(respLog);

      const relay = createTestRelay({
        approvalTimeoutMs: 60_000,
        fakeResponseLog: respLog,
        fakeScript: [
          {
            after: "turn/start",
            delayMs: 30,
            sendRequest: { method: "execCommandApproval" },
          },
        ],
      });

      const started = await relay.startTask({
        project: AURION_PROJECT,
        message: "crash-a",
        idempotency_key: `key-crash-a-${Date.now()}`,
      });

      await waitFor(() => {
        return (
          relay.getStatus({ task_id: started.task_id }).pending_approvals
            .length > 0
        );
      }, 2000);

      // Simulate SIGTERM handler path: flushAllDeny, wait for fake to record
      // the deny response, then shutdown.
      relay.approvals.flushAllDeny("SIGTERM");

      await waitFor(async () => {
        const lines = await readJsonLinesAsync(respLog);
        return lines.some((l) => l.result || l.error);
      }, 3000);

      const lines = await readJsonLinesAsync(respLog);
      const resp = lines.find((l) => l.result || l.error);
      assert.ok(resp, "fake received approval resolution before exit");
      assert.deepEqual(resp.result, { decision: "denied" });

      await relay.shutdown();
    }

    // ── Direction B: fake app-server exit while approval pending ──
    {
      const respLog = path.join(os.tmpdir(), `crb-crash-b-${Date.now()}.log`);
      if (fs.existsSync(respLog)) fs.unlinkSync(respLog);

      const relay = createTestRelay({
        approvalTimeoutMs: 60_000,
        fakeResponseLog: respLog,
        fakeScript: [
          {
            after: "turn/start",
            delayMs: 30,
            sendRequest: { method: "execCommandApproval" },
          },
          {
            after: "turn/start",
            delayMs: 150,
            exit: 1,
          },
        ],
      });

      const started = await relay.startTask({
        project: AURION_PROJECT,
        message: "crash-b",
        idempotency_key: `key-crash-b-${Date.now()}`,
      });

      await waitFor(() => {
        return (
          relay.getStatus({ task_id: started.task_id }).pending_approvals
            .length > 0
        );
      }, 2000);

      // Wait for fake exit
      await waitFor(() => {
        const st = relay.getStatus({ task_id: started.task_id });
        return st.status === "disconnected";
      }, 3000);

      const st = relay.getStatus({ task_id: started.task_id });
      assert.equal(st.status, "disconnected");
      assert.equal(st.pending_approvals.length, 0, "pending cleared");

      // Events should include approval_resolved denied
      const out = relay.readOutput({ task_id: started.task_id });
      const resolved = out.events.filter(
        (e) => e.type === "approval_resolved",
      );
      assert.ok(resolved.length >= 1, "approval_resolved event present");
      assert.ok(
        resolved.some((e) => e.decision === "denied"),
        "decision denied",
      );

      // Subsequent tool calls return codex_error / disconnected, do not hang
      const t0 = Date.now();
      await assert.rejects(
        () =>
          relay.continueTask({
            thread_id: started.thread_id,
            message: "after crash",
          }),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError);
          assert.ok(
            err.code === "disconnected" || err.code === "codex_error",
            `expected disconnected/codex_error got ${err.code}`,
          );
          return true;
        },
      );
      assert.ok(Date.now() - t0 < 5000, "must not hang");

      await relay.shutdown().catch(() => undefined);
    }
  });
});
