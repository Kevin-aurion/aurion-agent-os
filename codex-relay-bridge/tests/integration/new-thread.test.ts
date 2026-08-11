import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LAZYOFFICE_PROJECT,
  createTestRelay,
  methodsOf,
  readJsonLinesAsync,
} from "../helpers/spawn-bridge.js";
import { BridgeError } from "../../src/relay-core/index.js";

describe("new-thread", () => {
  let logFile: string;

  before(() => {
    logFile = path.join(os.tmpdir(), `crb-new-thread-${Date.now()}.log`);
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  });

  after(async () => {
    // cleanup leftover env
    delete process.env.FAKE_LOG;
    delete process.env.FAKE_SCRIPT;
    delete process.env.CODEX_BRIDGE_ALLOWLIST;
  });

  it("codex_start_task handshake + thread/start + turn/start; idempotent replay; allowlist reject", async () => {
    const relay = createTestRelay({ fakeLog: logFile });
    try {
      const r1 = await relay.startTask({
        project: LAZYOFFICE_PROJECT,
        message: "hello from test",
        idempotency_key: "key-new-thread-1",
      });

      assert.ok(r1.task_id, "task_id non-empty");
      assert.ok(r1.thread_id, "thread_id non-empty");
      assert.equal(r1.status, "active");
      assert.equal(r1.idempotent_replay, false);

      const lines = await readJsonLinesAsync(logFile);
      const methods = methodsOf(lines);

      // initialize → initialized (notification, no id) → thread/start → turn/start
      assert.ok(methods.includes("initialize"), "received initialize");
      assert.ok(methods.includes("initialized"), "received initialized notification");
      assert.ok(methods.includes("thread/start"), "received thread/start");
      assert.ok(methods.includes("turn/start"), "received turn/start");

      // Order check
      const idxInit = methods.indexOf("initialize");
      const idxInitialized = methods.indexOf("initialized");
      const idxThread = methods.indexOf("thread/start");
      const idxTurn = methods.indexOf("turn/start");
      assert.ok(idxInit < idxInitialized, "initialize before initialized");
      assert.ok(idxInitialized < idxThread, "initialized before thread/start");
      assert.ok(idxThread < idxTurn, "thread/start before turn/start");

      // thread/start cwd = project
      const threadStart = lines.find((l) => l.method === "thread/start");
      assert.ok(threadStart);
      const params = threadStart.params as { cwd?: string };
      assert.equal(params.cwd, fs.realpathSync(LAZYOFFICE_PROJECT));

      // initialized has no id
      const initialized = lines.find((l) => l.method === "initialized");
      assert.ok(initialized);
      assert.equal("id" in initialized, false);

      // Idempotent replay
      const beforeCount = lines.filter((l) => l.method === "thread/start").length;
      const r2 = await relay.startTask({
        project: LAZYOFFICE_PROJECT,
        message: "hello again",
        idempotency_key: "key-new-thread-1",
      });
      assert.equal(r2.idempotent_replay, true);
      assert.equal(r2.task_id, r1.task_id);
      assert.equal(r2.thread_id, r1.thread_id);

      const lines2 = await readJsonLinesAsync(logFile);
      const afterCount = lines2.filter((l) => l.method === "thread/start").length;
      assert.equal(afterCount, beforeCount, "no second thread/start on idempotent replay");
    } finally {
      await relay.shutdown();
    }

    // Allowlist reject — restrict to a temp dir; paths outside (e.g. /etc) must fail.
    // Default allowlist is "/" (open); set CODEX_BRIDGE_ALLOWLIST to verify the gate still works.
    const prevAllowlist = process.env.CODEX_BRIDGE_ALLOWLIST;
    const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-allow-"));
    process.env.CODEX_BRIDGE_ALLOWLIST = allowedDir;

    const denyLog = path.join(os.tmpdir(), `crb-deny-${Date.now()}.log`);
    const relay2 = createTestRelay({ fakeLog: denyLog });
    try {
      await assert.rejects(
        () =>
          relay2.startTask({
            project: "/etc",
            message: "should fail",
            idempotency_key: "key-deny-etc",
          }),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, "invalid_input");
          return true;
        },
      );
      // Zero traffic to fake: either no log or empty
      if (fs.existsSync(denyLog)) {
        const lines = await readJsonLinesAsync(denyLog);
        assert.equal(lines.length, 0, "allowlist reject must not touch app-server");
      }

      // Non-existent path still returns invalid_input (realpath fails before allowlist match)
      const missing = path.join(allowedDir, "does-not-exist-" + Date.now());
      await assert.rejects(
        () =>
          relay2.startTask({
            project: missing,
            message: "should fail",
            idempotency_key: "key-deny-missing",
          }),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, "invalid_input");
          return true;
        },
      );
    } finally {
      if (prevAllowlist === undefined) {
        delete process.env.CODEX_BRIDGE_ALLOWLIST;
      } else {
        process.env.CODEX_BRIDGE_ALLOWLIST = prevAllowlist;
      }
      // may not have started child — shutdown is fine
      await relay2.shutdown().catch(() => undefined);
    }
  });
});
