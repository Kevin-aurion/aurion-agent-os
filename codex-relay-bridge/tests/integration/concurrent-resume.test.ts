import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTestRelay,
  readJsonLinesAsync,
} from "../helpers/spawn-bridge.js";

describe("concurrent-resume", () => {
  it("two concurrent continueTask on same unregistered thread_id → exactly one thread/resume", async () => {
    const logFile = path.join(
      os.tmpdir(),
      `crb-concurrent-resume-${Date.now()}.log`,
    );
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

    const relay = createTestRelay({ fakeLog: logFile });
    try {
      await relay.start();

      const unknownThread = "thr_concurrent_resume_once";

      const [r1, r2] = await Promise.all([
        relay.continueTask({
          thread_id: unknownThread,
          message: "continue-a",
        }),
        relay.continueTask({
          thread_id: unknownThread,
          message: "continue-b",
        }),
      ]);

      assert.ok(r1.accepted);
      assert.ok(r2.accepted);
      assert.equal(r1.task_id, r2.task_id, "same task after single resume");
      assert.equal(
        relay.getStatus({ task_id: r1.task_id }).thread_id,
        unknownThread,
      );

      const lines = await readJsonLinesAsync(logFile);
      const resumes = lines.filter((l) => l.method === "thread/resume");
      assert.equal(
        resumes.length,
        1,
        `expected exactly one thread/resume, got ${resumes.length}`,
      );
      assert.equal(
        (resumes[0]!.params as { threadId: string }).threadId,
        unknownThread,
      );

      // Both continues should still drive turns (serialized under the lock)
      const turns = lines.filter(
        (l) => l.method === "turn/start" || l.method === "turn/steer",
      );
      assert.ok(turns.length >= 2, "both continues should issue turn ops");
    } finally {
      await relay.shutdown();
    }
  });
});
