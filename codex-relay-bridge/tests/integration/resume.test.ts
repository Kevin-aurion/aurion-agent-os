import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTestRelay,
  methodsOf,
  readJsonLinesAsync,
} from "../helpers/spawn-bridge.js";

describe("resume", () => {
  it("unknown thread_id → thread/resume then turn/start; mode turn_start", async () => {
    const logFile = path.join(os.tmpdir(), `crb-resume-${Date.now()}.log`);
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

    const relay = createTestRelay({ fakeLog: logFile });
    try {
      // Start client (handshake) without registering any thread
      await relay.start();

      const unknownThread = "thr_unknown_resume_test";
      const out = await relay.continueTask({
        thread_id: unknownThread,
        message: "continue please",
      });

      assert.equal(out.mode, "turn_start");
      assert.equal(out.accepted, true);
      assert.ok(out.task_id);
      assert.ok(out.turn_id);

      const lines = await readJsonLinesAsync(logFile);
      const methods = methodsOf(lines);

      assert.ok(methods.includes("thread/resume"), "must call thread/resume");
      assert.ok(!methods.includes("thread/start"), "must NOT call thread/start");
      assert.ok(methods.includes("turn/start"), "must call turn/start");

      const resume = lines.find((l) => l.method === "thread/resume");
      assert.ok(resume);
      assert.equal(
        (resume.params as { threadId: string }).threadId,
        unknownThread,
      );

      const idxResume = methods.indexOf("thread/resume");
      const idxTurn = methods.indexOf("turn/start");
      assert.ok(idxResume < idxTurn, "resume before turn/start");
    } finally {
      await relay.shutdown();
    }
  });
});
