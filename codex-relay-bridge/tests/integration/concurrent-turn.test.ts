import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AURION_PROJECT,
  createTestRelay,
  readJsonLinesAsync,
} from "../helpers/spawn-bridge.js";
import { BridgeError } from "../../src/relay-core/index.js";

describe("concurrent-turn", () => {
  it("active turn: concurrent continue → turn/steer with expectedTurnId; second fails with conflict", async () => {
    const logFile = path.join(os.tmpdir(), `crb-concurrent-${Date.now()}.log`);
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

    // Script: second turn/steer returns error
    const relay = createTestRelay({
      fakeLog: logFile,
      fakeScript: [
        {
          on: "turn/steer",
          nth: 2,
          error: { code: -32000, message: "steer rejected: turn busy" },
        },
      ],
    });

    try {
      const started = await relay.startTask({
        project: AURION_PROJECT,
        message: "first",
        idempotency_key: "key-concurrent-1",
      });
      assert.equal(started.status, "active");

      const status = relay.getStatus({ task_id: started.task_id });
      const t1 = status.current_turn_id;
      assert.ok(t1, "current_turn_id set after start");

      // Fire two continues concurrently
      const p1 = relay.continueTask({
        thread_id: started.thread_id,
        message: "steer-a",
      });
      const p2 = relay.continueTask({
        thread_id: started.thread_id,
        message: "steer-b",
      });

      const results = await Promise.allSettled([p1, p2]);

      // One should succeed, one should conflict (or both succeed if fake accepts first only)
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.ok(fulfilled.length >= 1, "at least one steer accepted");
      assert.ok(rejected.length >= 1, "at least one steer fails");

      for (const r of rejected) {
        assert.ok(r.status === "rejected");
        const err = r.reason;
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, "conflict");
      }

      for (const r of fulfilled) {
        assert.ok(r.status === "fulfilled");
        assert.equal(r.value.mode, "turn_steer");
        assert.equal(r.value.accepted, true);
      }

      const lines = await readJsonLinesAsync(logFile);
      const steers = lines.filter((l) => l.method === "turn/steer");
      assert.ok(steers.length >= 2, "both continue calls issued turn/steer");

      for (const s of steers) {
        const p = s.params as { expectedTurnId?: string };
        assert.equal(
          p.expectedTurnId,
          t1,
          "expectedTurnId must be t1 (no guessing)",
        );
      }

      // Serialized: no interleaved params mutation — both complete as separate lines
      // State not corrupted
      const after = relay.getStatus({ task_id: started.task_id });
      assert.ok(
        after.status === "active" || after.status === "idle",
        "status intact after conflict",
      );
      assert.ok(after.task_id === started.task_id);
    } finally {
      await relay.shutdown();
    }
  });
});
