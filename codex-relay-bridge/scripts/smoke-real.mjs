#!/usr/bin/env node
/**
 * Real codex app-server smoke (not LIVE integration test).
 * Proves handshake works when responses omit `jsonrpc`.
 *
 * Usage:
 *   export PATH="$HOME/.local/node/bin:$PATH"
 *   node scripts/smoke-real.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CODEX_BIN =
  process.env.CODEX_BIN ??
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const PROJECT =
  process.env.SMOKE_PROJECT ?? process.cwd();
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(...args) {
  console.error("[smoke-real]", ...args);
}

function main() {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let buf = "";
    let nextId = 1;
    const pending = new Map();
    const transcript = [];

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`smoke timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stderr.on("data", (c) => {
      const t = c.toString("utf8").trimEnd();
      if (t) log("stderr:", t);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code, signal) => {
      log(`child exit code=${code} signal=${signal}`);
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          log("non-json line:", line.slice(0, 200));
          continue;
        }
        transcript.push({ dir: "←", msg });
        log("RECV:", JSON.stringify(msg).slice(0, 400));

        // Tolerate missing jsonrpc (this is the bug under test)
        if ("id" in msg && ("result" in msg || "error" in msg)) {
          const p = pending.get(String(msg.id));
          if (p) {
            pending.delete(String(msg.id));
            if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        }
      }
    });

    function send(obj) {
      const line = JSON.stringify(obj) + "\n";
      transcript.push({ dir: "→", msg: obj });
      log("SEND:", JSON.stringify(obj).slice(0, 400));
      child.stdin.write(line);
    }

    function request(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(String(id), { resolve: res, reject: rej });
        const msg = { jsonrpc: "2.0", id, method };
        if (params !== undefined) msg.params = params;
        send(msg);
      });
    }

    (async () => {
      try {
        log("spawning", CODEX_BIN, "app-server");
        const initResult = await request("initialize", {
          clientInfo: {
            name: "codex-relay-bridge-smoke",
            title: "Codex Relay Bridge Smoke",
            version: "0.1.0",
          },
          capabilities: null,
        });
        log("initialize RESULT keys:", Object.keys(initResult ?? {}));
        console.log(
          "OK initialize result (truncated):",
          JSON.stringify(initResult).slice(0, 500),
        );

        // Notification without id (real protocol)
        send({ jsonrpc: "2.0", method: "initialized" });

        const list = await request("thread/list", {});
        console.log(
          "OK thread/list result (truncated):",
          JSON.stringify(list).slice(0, 500),
        );

        // Optional: start a short turn if SMOKE_TURN=1
        if (process.env.SMOKE_TURN === "1") {
          const started = await request("thread/start", {
            cwd: PROJECT,
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
          });
          const threadId = started?.thread?.id;
          console.log("OK thread/start threadId=", threadId);
          const turn = await request("turn/start", {
            threadId,
            input: [
              {
                type: "text",
                text: "reply with the single word PONG",
                text_elements: [],
              },
            ],
          });
          console.log(
            "OK turn/start (truncated):",
            JSON.stringify(turn).slice(0, 400),
          );

          // Wait briefly for agent_message notifications
          await new Promise((r) => setTimeout(r, 45_000));
          const agentish = transcript.filter(
            (t) =>
              t.dir === "←" &&
              typeof t.msg?.method === "string" &&
              (t.msg.method.includes("agentMessage") ||
                t.msg.method === "turn/completed" ||
                t.msg.method === "item/completed"),
          );
          console.log(
            "agent-related notifications:",
            agentish.length,
            agentish
              .slice(0, 5)
              .map((t) => t.msg.method)
              .join(", "),
          );
        }

        clearTimeout(timer);
        child.kill("SIGTERM");
        console.log("SMOKE REAL: PASS (handshake + thread/list without jsonrpc on wire)");
        resolve({ transcript });
      } catch (err) {
        clearTimeout(timer);
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        reject(err);
      }
    })();
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("SMOKE REAL: FAIL", err);
    process.exit(1);
  });
