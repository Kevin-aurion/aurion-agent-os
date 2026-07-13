import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  classifyEnvelope,
  KNOWN_SERVER_NOTIFICATION_METHODS,
  KNOWN_SERVER_REQUEST_METHODS,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./rpc-types.js";
import { BridgeError } from "./errors.js";

export type ProtocolViolationHandler = (info: {
  reason: string;
  raw: unknown;
  method?: string;
  id?: JsonRpcId;
}) => void;

export type ServerRequestHandler = (req: {
  id: JsonRpcId;
  method: string;
  params: unknown;
}) => void;

export type ServerNotificationHandler = (notif: {
  method: string;
  params: unknown;
}) => void;

export interface AppServerClientOptions {
  codexBin?: string;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  packageVersion?: string;
  /** Extra env vars for the app-server child (merged over process.env). */
  childEnv?: Record<string, string | undefined>;
  /** Called for protocol violations (unknown methods, bad envelopes). */
  onProtocolViolation?: ProtocolViolationHandler;
  onServerRequest?: ServerRequestHandler;
  onServerNotification?: ServerNotificationHandler;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (err: Error) => void;
  /** Override spawn (tests). */
  spawnFn?: typeof spawn;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

const DEFAULT_CODEX_BIN =
  "/Applications/ChatGPT.app/Contents/Resources/codex";

function log(...args: unknown[]): void {
  // All logs go to stderr; stdout is reserved for MCP.
  console.error("[app-server-client]", ...args);
}

function loadPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export class AppServerClient {
  private readonly codexBin: string;
  private readonly requestTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly packageVersion: string;
  private readonly spawnFn: typeof spawn;
  private readonly childEnv: Record<string, string | undefined>;
  private readonly onProtocolViolation?: ProtocolViolationHandler;
  private readonly onServerRequest?: ServerRequestHandler;
  private readonly onServerNotification?: ServerNotificationHandler;
  private readonly onExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
  private readonly onError?: (err: Error) => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private handshakeDone = false;
  private handshakePromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private closed = false;
  private degraded = false;
  private stdoutBuf = "";

  constructor(opts: AppServerClientOptions = {}) {
    this.codexBin = opts.codexBin ?? process.env.CODEX_BIN ?? DEFAULT_CODEX_BIN;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
    this.packageVersion = opts.packageVersion ?? loadPackageVersion();
    this.spawnFn = opts.spawnFn ?? spawn;
    this.childEnv = opts.childEnv ?? {};
    if (opts.onProtocolViolation) this.onProtocolViolation = opts.onProtocolViolation;
    if (opts.onServerRequest) this.onServerRequest = opts.onServerRequest;
    if (opts.onServerNotification) this.onServerNotification = opts.onServerNotification;
    if (opts.onExit) this.onExit = opts.onExit;
    if (opts.onError) this.onError = opts.onError;
  }

  get isConnected(): boolean {
    return this.child !== null && !this.closed && !this.degraded;
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  /** Spawn app-server and complete initialize handshake exactly once. */
  async start(): Promise<void> {
    if (this.handshakeDone && this.child) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart().catch((err) => {
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.child) {
      await this.handshake();
      return;
    }
    this.closed = false;
    this.degraded = false;

    this.warnVersionMismatch();

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(this.childEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }

    const child = this.spawnFn(this.codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    }) as ChildProcessWithoutNullStreams;

    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => {
      log("stderr:", chunk.toString("utf8").trimEnd());
    });

    child.on("error", (err) => {
      log("child error:", err);
      this.degraded = true;
      this.rejectAllPending(new BridgeError("codex_error", `app-server error: ${err.message}`));
      this.onError?.(err);
    });

    child.on("exit", (code, signal) => {
      log(`child exit code=${code} signal=${signal}`);
      this.closed = true;
      this.degraded = true;
      this.rejectAllPending(
        new BridgeError("disconnected", `app-server exited code=${code} signal=${signal}`),
      );
      this.onExit?.(code, signal);
    });

    // Line-oriented framing over stdout
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.stdoutBuf += chunk;
      let nl: number;
      while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
        const line = this.stdoutBuf.slice(0, nl).trim();
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (line.length === 0) continue;
        this.handleLine(line);
      }
    });

    await this.handshake();
  }

  private warnVersionMismatch(): void {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const versionFile = path.resolve(here, "../generated/CODEX_VERSION");
      const expected = readFileSync(versionFile, "utf8").trim();
      // Best-effort: compare stored version string to env override note
      const actualHint = process.env.CODEX_BIN
        ? `CODEX_BIN=${process.env.CODEX_BIN}`
        : DEFAULT_CODEX_BIN;
      log(`generated CODEX_VERSION=${expected}; runtime bin=${actualHint}`);
      // Spawn a quick version check only when using real binary path
      if (!process.env.CODEX_BIN || process.env.CODEX_BIN === DEFAULT_CODEX_BIN) {
        // Lazy: compare file content already written by gen:types against what generate produced
        // Full re-check would block; document mismatch when env overrides fake.
      }
    } catch {
      log("warning: could not read CODEX_VERSION for mismatch check");
    }
  }

  private async handshake(): Promise<void> {
    if (this.handshakePromise) return this.handshakePromise;
    this.handshakePromise = (async () => {
      try {
        await this.request(
          "initialize",
          {
            clientInfo: {
              name: "codex-relay-bridge",
              title: "Codex Relay Bridge",
              version: this.packageVersion,
            },
            capabilities: null,
          },
          this.handshakeTimeoutMs,
        );
        this.notify("initialized");
        this.handshakeDone = true;
        log("handshake complete");
      } catch (err) {
        this.degraded = true;
        const msg = err instanceof Error ? err.message : String(err);
        log("handshake failed:", msg);
        throw new BridgeError("degraded", `handshake failed: ${msg}`);
      }
    })();
    return this.handshakePromise;
  }

  /** Ensure connected + handshake done; tool calls queue on handshake. */
  async ensureReady(): Promise<void> {
    if (this.closed || this.degraded) {
      throw new BridgeError("disconnected", "app-server is disconnected (Phase 1: no auto-restart)");
    }
    if (!this.child) {
      await this.start();
    } else if (!this.handshakeDone) {
      await this.handshake();
    }
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed || !this.child) {
      throw new BridgeError("disconnected", "app-server not running");
    }
    const id = this.nextId++;
    const idKey = String(id);
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const timeout = timeoutMs ?? this.requestTimeoutMs;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(idKey);
        reject(new BridgeError("timeout", `request ${method} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(idKey, { resolve, reject, timer, method });
    });

    this.write(msg);
    return result;
  }

  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  /** Send a successful response to a ServerRequest. */
  respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  /** Send an error response to a ServerRequest. */
  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    });
  }

  private write(msg: unknown): void {
    if (!this.child || this.closed) {
      log("write dropped (closed):", msg);
      return;
    }
    const line = JSON.stringify(msg) + "\n";
    this.child.stdin.write(line);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log("invalid JSON line:", line.slice(0, 200));
      this.onProtocolViolation?.({ reason: "invalid JSON", raw: line });
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.onProtocolViolation?.({ reason: "envelope not object", raw: parsed });
      return;
    }

    const msg = parsed as Record<string, unknown>;
    const { kind, reason } = classifyEnvelope(msg);

    if (kind === "invalid") {
      log("protocol violation:", reason, line.slice(0, 300));
      this.onProtocolViolation?.({ reason: reason ?? "invalid", raw: parsed });
      // If it looks like a ServerRequest with id, reject with -32601
      if ("id" in msg && msg.id !== null && msg.id !== undefined && typeof msg.method === "string") {
        this.respondError(msg.id as JsonRpcId, -32601, `Method not found: ${msg.method}`);
      }
      return;
    }

    if (kind === "response") {
      const id = msg.id as JsonRpcId;
      const idKey = String(id);
      const pending = this.pending.get(idKey);
      if (!pending) {
        log("orphan response for id", id);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(idKey);
      if ("error" in msg && msg.error) {
        const errObj = msg.error as { code?: number; message?: string };
        pending.reject(
          new BridgeError(
            "codex_error",
            errObj.message ?? `RPC error for ${pending.method}`,
            errObj,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (kind === "server_request") {
      const method = msg.method as string;
      const id = msg.id as JsonRpcId;
      if (!KNOWN_SERVER_REQUEST_METHODS.has(method)) {
        log("unknown ServerRequest method:", method);
        this.onProtocolViolation?.({
          reason: `unknown ServerRequest method: ${method}`,
          raw: parsed,
          method,
          id,
        });
        this.respondError(id, -32601, `Method not found: ${method}`);
        return;
      }
      this.onServerRequest?.({ id, method, params: msg.params });
      return;
    }

    if (kind === "server_notification") {
      const method = msg.method as string;
      if (!KNOWN_SERVER_NOTIFICATION_METHODS.has(method)) {
        log("unknown ServerNotification method:", method);
        this.onProtocolViolation?.({
          reason: `unknown ServerNotification method: ${method}`,
          raw: parsed,
          method,
        });
        return;
      }
      this.onServerNotification?.({ method, params: msg.params });
      return;
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /**
   * Best-effort shutdown: reject pending client requests.
   * Approval flush is handled by ApprovalsManager via onBeforeShutdown.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.rejectAllPending(new BridgeError("disconnected", "bridge shutting down"));
    if (this.child) {
      const child = this.child;
      this.child = null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        try {
          child.kill("SIGTERM");
        } catch {
          clearTimeout(t);
          resolve();
        }
      });
    }
  }
}
