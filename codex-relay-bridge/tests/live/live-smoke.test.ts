/**
 * Live smoke against real Codex app-server binary.
 * Default: SKIPPED. Set LIVE=1 to run.
 *
 * Does NOT use AppleScript / System Events.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RelayCore } from "../../src/relay-core/index.js";

const LIVE = process.env.LIVE === "1";
const CODEX_BIN =
  process.env.CODEX_BIN ??
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const PROJECT =
  process.env.LIVE_PROJECT ?? "/Users/kevin/Documents/aurion";

describe("live-smoke", { skip: !LIVE }, () => {
  it("initialize → thread/start → turn/start → turn/completed with PONG", async () => {
    const relay = new RelayCore({
      codexBin: CODEX_BIN,
      requestTimeoutMs: 120_000,
      approvalTimeoutMs: 30_000,
      handshakeTimeoutMs: 30_000,
    });

    try {
      await relay.start();

      const started = await relay.startTask({
        project: PROJECT,
        message: "reply with the single word PONG",
        idempotency_key: `live-smoke-${Date.now()}`,
      });

      assert.ok(started.task_id);
      assert.ok(started.thread_id);

      // Wait for turn_completed + agent_message containing PONG
      const deadline = Date.now() + 120_000;
      let sawPong = false;
      let sawCompleted = false;

      while (Date.now() < deadline) {
        const out = relay.readOutput({ task_id: started.task_id });
        for (const e of out.events) {
          if (e.type === "turn_completed") sawCompleted = true;
          if (
            (e.type === "agent_message" || e.type === "agent_message_delta") &&
            e.text &&
            /PONG/i.test(e.text)
          ) {
            sawPong = true;
          }
        }
        if (sawCompleted && sawPong) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      assert.ok(sawCompleted, "expected turn/completed");
      assert.ok(sawPong, "expected agent_message containing PONG");

      // thread/list should be visible via raw request
      const list = await relay.client.request("thread/list", {});
      assert.ok(list !== undefined);

      // turn/interrupt should not throw
      const st = relay.getStatus({ task_id: started.task_id });
      if (st.current_turn_id) {
        await relay.client.request("turn/interrupt", {
          threadId: started.thread_id,
          turnId: st.current_turn_id,
        });
      } else {
        // idle after completion — interrupt may not apply; call with last known
        // Plan: turn/interrupt 不報錯 — try best-effort with empty or skip
        try {
          await relay.client.request("turn/interrupt", {
            threadId: started.thread_id,
            turnId: "noop",
          });
        } catch {
          // acceptable if no active turn
        }
      }
    } finally {
      await relay.shutdown();
    }
  });
});
