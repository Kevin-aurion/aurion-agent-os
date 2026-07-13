#!/usr/bin/env node
/**
 * Smoke: MCP initialize + tools/list against dist/main.js over stdio.
 * Must list 5 tools without waiting on app-server handshake.
 *
 * Note: @modelcontextprotocol/sdk StdioServerTransport uses **newline-delimited
 * JSON** (not Content-Length framing).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const mainJs = path.join(root, "dist", "main.js");
const nodeBin = process.execPath;

function log(...args) {
  console.error("[smoke-mcp]", ...args);
}

function main() {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [mainJs], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      cwd: root,
    });

    let buf = "";
    const pending = new Map();
    let nextId = 1;
    let ready = false;
    const readyWaiters = [];
    const deadline = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("MCP smoke timeout"));
    }, 20_000);

    child.stderr.on("data", (c) => {
      const t = c.toString("utf8");
      if (t.trim()) log("stderr:", t.trim().slice(0, 400));
      if (t.includes("MCP stdio server running")) {
        ready = true;
        for (const w of readyWaiters.splice(0)) w();
      }
    });

    child.on("error", (e) => {
      clearTimeout(deadline);
      reject(e);
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
          log("bad line", line.slice(0, 200));
          continue;
        }
        log("RECV:", JSON.stringify(msg).slice(0, 400));
        if (msg.id !== undefined && pending.has(String(msg.id))) {
          const p = pending.get(String(msg.id));
          pending.delete(String(msg.id));
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      }
    });

    function waitReady() {
      if (ready) return Promise.resolve();
      return new Promise((r) => readyWaiters.push(r));
    }

    function send(obj) {
      const line = JSON.stringify(obj) + "\n";
      log("SEND:", line.trim().slice(0, 200));
      child.stdin.write(line);
    }

    function request(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(String(id), { resolve: res, reject: rej });
        send({
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        });
      });
    }

    (async () => {
      try {
        await waitReady();
        await new Promise((r) => setTimeout(r, 50));

        const init = await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "smoke-mcp", version: "0.0.1" },
        });
        console.log(
          "OK MCP initialize serverInfo:",
          JSON.stringify(init?.serverInfo ?? init).slice(0, 300),
        );

        send({ jsonrpc: "2.0", method: "notifications/initialized" });

        const tools = await request("tools/list", {});
        const names = (tools?.tools ?? []).map((t) => t.name);
        console.log(
          "OK tools/list count=",
          names.length,
          "names=",
          names.join(", "),
        );

        if (names.length !== 5) {
          throw new Error(
            `expected 5 tools, got ${names.length}: ${names.join(",")}`,
          );
        }
        const expected = [
          "codex_start_task",
          "codex_continue_task",
          "codex_get_status",
          "codex_read_output",
          "codex_respond_approval",
        ];
        for (const n of expected) {
          if (!names.includes(n)) throw new Error(`missing tool ${n}`);
        }

        clearTimeout(deadline);
        child.kill("SIGTERM");
        console.log("SMOKE MCP: PASS");
        resolve();
      } catch (err) {
        clearTimeout(deadline);
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
    console.error("SMOKE MCP: FAIL", err);
    process.exit(1);
  });
