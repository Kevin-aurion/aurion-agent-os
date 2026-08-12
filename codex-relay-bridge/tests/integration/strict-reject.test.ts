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

describe("strict-reject", () => {
  it("unknown notification, unknown ServerRequest, extra envelope keys → protocol_violation; bridge stays up", async () => {
    const respLog = path.join(os.tmpdir(), `crb-strict-${Date.now()}.log`);
    if (fs.existsSync(respLog)) fs.unlinkSync(respLog);

    const relay = createTestRelay({
      fakeResponseLog: respLog,
      fakeScript: [
        {
          after: "turn/start",
          delayMs: 20,
          sendNotification: { method: "bogus/thing", params: { x: 1 } },
        },
        {
          after: "turn/start",
          delayMs: 40,
          sendRequest: { method: "bogus/approve", params: { y: 2 } },
        },
        {
          after: "turn/start",
          delayMs: 60,
          badEnvelope: {
            method: "error",
            params: { message: "ok-looking but extra" },
            extraField: true,
          },
        },
      ],
    });

    try {
      const started = await relay.startTask({
        project: AURION_PROJECT,
        message: "strict",
        idempotency_key: `key-strict-${Date.now()}`,
      });

      // Wait for protocol violations to land
      await waitFor(() => {
        const out = relay.readOutput({ task_id: started.task_id });
        return out.events.some((e) => e.type === "protocol_violation");
      }, 3000);

      const out = relay.readOutput({ task_id: started.task_id });
      const violations = out.events.filter(
        (e) => e.type === "protocol_violation",
      );
      assert.ok(
        violations.length >= 1,
        `expected protocol_violation events, got ${JSON.stringify(out.events)}`,
      );

      // Unknown ServerRequest must receive -32601
      await waitFor(async () => {
        const lines = await readJsonLinesAsync(respLog);
        return lines.some(
          (l) =>
            l.error &&
            (l.error as { code: number }).code === -32601,
        );
      }, 2000);

      const lines = await readJsonLinesAsync(respLog);
      const err32601 = lines.find(
        (l) =>
          l.error && (l.error as { code: number }).code === -32601,
      );
      assert.ok(err32601, "unknown ServerRequest got -32601");
      assert.match(
        (err32601.error as { message: string }).message,
        /bogus\/approve|Method not found/i,
      );

      // Bridge still healthy: existing task status readable, can continue
      const st = relay.getStatus({ task_id: started.task_id });
      assert.equal(st.task_id, started.task_id);
      assert.ok(st.status === "active" || st.status === "idle");

      // Emit turn/completed so we can continue with turn_start, or steer if active
      const cont = await relay.continueTask({
        thread_id: started.thread_id,
        message: "still alive",
      });
      assert.ok(cont.accepted || cont.mode);
    } finally {
      await relay.shutdown();
    }
  });
});
