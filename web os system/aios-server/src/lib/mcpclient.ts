// Reusable MCP session abstraction: stdio + loopback-HTTP transports,
// one-shot openSession, and a pooled McpSessionManager for the broker.
// JSON-RPC 2.0 newline-delimited (stdio) or POST (loopback-http).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import readline from 'node:readline';
import { ulid } from 'ulid';
import { assertLoopbackUrl } from './mcpregistry.js';

export interface McpClient {
  listTools(): Promise<Array<{ name: string; description?: string }>>;
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export class McpError extends Error {
  constructor(
    public code: string,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export interface McpTransportConfig {
  kind: 'stdio' | 'loopback-http';
  label: string;
  // stdio
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  // loopback-http
  url?: string;
  // common
  protocolVersion?: string;
  callTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxReconnects?: number;
  errorHint?: string;
}

export interface McpCallOptions {
  timeoutMs?: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
  onProgress?: (p: { progress?: number; total?: number; message?: string }) => void;
}

export interface McpSession extends McpClient {
  readonly id: string;
  isAlive(): boolean;
  request(method: string, params?: unknown, opts?: McpCallOptions): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  call(name: string, args?: Record<string, unknown>, opts?: McpCallOptions): Promise<unknown>;
}

const DEFAULT_CALL_TIMEOUT_MS = 12_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RECONNECTS = 3;
const DEFAULT_PROTOCOL = '2024-11-05';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number | string; message?: string; data?: unknown };
}

// ── Internal transport interface ─────────────────────────────────────────────

interface McpTransport {
  send(msg: object): void;
  onMessage(cb: (msg: JsonRpcMessage) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): void;
  isAlive(): boolean;
}

function appendHint(msg: string, hint?: string): string {
  if (!hint) return msg;
  if (msg.includes(hint)) return msg;
  // Prefer Chinese-style separator when hint is Chinese; else space/period.
  return msg.endsWith('。') || msg.endsWith('.') ? `${msg}${hint}` : `${msg}。${hint}`;
}

// ── Stdio transport ──────────────────────────────────────────────────────────

class StdioTransport implements McpTransport {
  private alive = true;
  private rl: readline.Interface | null = null;
  private messageCbs: Array<(msg: JsonRpcMessage) => void> = [];
  private closeCbs: Array<(err?: Error) => void> = [];
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly label: string,
    private readonly errorHint?: string,
  ) {
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));
    child.stderr.on('data', () => {
      // Drain stderr so the child cannot block on a full pipe.
    });
    child.on('exit', (code, signal) => {
      if (this.closed) return;
      this.invalidate(
        new Error(
          appendHint(
            `MCP process exited (code=${code}, signal=${signal})`,
            this.errorHint,
          ),
        ),
      );
    });
    child.on('error', (err) => {
      this.invalidate(
        new Error(appendHint(`MCP process error: ${err.message}`, this.errorHint)),
      );
    });
  }

  private onLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(t) as JsonRpcMessage;
    } catch {
      return;
    }
    for (const cb of this.messageCbs) cb(msg);
  }

  private invalidate(err?: Error): void {
    if (!this.alive && this.closed) return;
    this.alive = false;
    for (const cb of this.closeCbs) {
      try {
        cb(err);
      } catch {
        // ignore
      }
    }
  }

  send(msg: object): void {
    if (!this.alive || this.closed) {
      throw new McpError('closed', `MCP transport closed (${this.label})`);
    }
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  onMessage(cb: (msg: JsonRpcMessage) => void): void {
    this.messageCbs.push(cb);
  }

  onClose(cb: (err?: Error) => void): void {
    this.closeCbs.push(cb);
  }

  isAlive(): boolean {
    return this.alive && !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    try {
      this.rl?.close();
    } catch {
      // ignore
    }
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        if (!this.child.killed) this.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 500).unref?.();
  }
}

function assertExecutable(bin: string, label: string, errorHint?: string): void {
  try {
    accessSync(bin, fsConstants.X_OK);
  } catch {
    throw new Error(appendHint(`${label} 找不到或不可執行: ${bin}`, errorHint));
  }
}

function createStdioTransport(cfg: McpTransportConfig): StdioTransport {
  if (!cfg.command) {
    throw new McpError('bad_config', appendHint(`${cfg.label}: stdio requires command`, cfg.errorHint));
  }
  assertExecutable(cfg.command, cfg.label, cfg.errorHint);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(cfg.command, cfg.args ?? [], {
      cwd: cfg.cwd,
      env: { ...process.env, ...cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  } catch (e) {
    throw new Error(
      appendHint(
        `無法啟動 ${cfg.label}: ${e instanceof Error ? e.message : String(e)}`,
        cfg.errorHint,
      ),
    );
  }
  return new StdioTransport(child, cfg.label, cfg.errorHint);
}

// ── Loopback HTTP transport ──────────────────────────────────────────────────

class LoopbackHttpTransport implements McpTransport {
  private alive = true;
  private closed = false;
  private messageCbs: Array<(msg: JsonRpcMessage) => void> = [];
  private closeCbs: Array<(err?: Error) => void> = [];
  private readonly url: string;

  constructor(url: string, private readonly label: string) {
    this.url = url;
  }

  send(msg: object): void {
    if (!this.alive || this.closed) {
      throw new McpError('closed', `MCP transport closed (${this.label})`);
    }
    const body = JSON.stringify(msg);
    const hasId = msg && typeof msg === 'object' && 'id' in (msg as object);
    // Fire-and-forget for notifications (no id); await reply for requests.
    const p = fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    })
      .then(async (res) => {
        if (!hasId) return;
        const text = await res.text();
        if (!text) return;
        let parsed: JsonRpcMessage;
        try {
          parsed = JSON.parse(text) as JsonRpcMessage;
        } catch {
          return;
        }
        for (const cb of this.messageCbs) cb(parsed);
      })
      .catch((err) => {
        if (this.closed) return;
        // Surface as a synthetic error reply if we can extract id
        const id = hasId ? (msg as { id?: number | string }).id : undefined;
        if (id != null) {
          for (const cb of this.messageCbs) {
            cb({
              jsonrpc: '2.0',
              id,
              error: {
                code: 'transport_error',
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
        }
      });
    void p;
  }

  onMessage(cb: (msg: JsonRpcMessage) => void): void {
    this.messageCbs.push(cb);
  }

  onClose(cb: (err?: Error) => void): void {
    this.closeCbs.push(cb);
  }

  isAlive(): boolean {
    return this.alive && !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    for (const cb of this.closeCbs) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
  }
}

function createHttpTransport(cfg: McpTransportConfig): LoopbackHttpTransport {
  if (!cfg.url) {
    throw new McpError('bad_config', appendHint(`${cfg.label}: loopback-http requires url`, cfg.errorHint));
  }
  // Fail-closed: only exact loopback hosts.
  const parsed = assertLoopbackUrl(cfg.url);
  return new LoopbackHttpTransport(parsed.toString(), cfg.label);
}

// ── Session ──────────────────────────────────────────────────────────────────

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: McpCallOptions['onProgress'];
  abortHandler?: () => void;
  signal?: AbortSignal;
};

class SessionImpl implements McpSession {
  readonly id: string;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private alive = true;
  private closed = false;
  private readonly callTimeoutMs: number;
  private readonly errorHint?: string;
  private readonly label: string;
  /** Optional hook when a call succeeds (used by session manager to reset reconnect counter). */
  onSuccessfulCall?: () => void;

  constructor(
    private readonly transport: McpTransport,
    cfg: McpTransportConfig,
    id?: string,
  ) {
    this.id = id ?? ulid();
    this.callTimeoutMs = cfg.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.errorHint = cfg.errorHint;
    this.label = cfg.label;

    transport.onMessage((msg) => this.onMessage(msg));
    transport.onClose((err) => {
      if (this.closed) return;
      this.alive = false;
      this.failAll(err ?? new McpError('closed', `MCP session closed (${this.label})`));
    });
  }

  isAlive(): boolean {
    return this.alive && !this.closed && this.transport.isAlive();
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.signal && p.abortHandler) {
        try {
          p.signal.removeEventListener('abort', p.abortHandler);
        } catch {
          // ignore
        }
      }
      p.reject(err);
    }
    this.pending.clear();
  }

  private onMessage(msg: JsonRpcMessage): void {
    // Progress notifications
    if (msg.method === 'notifications/progress' && msg.id == null) {
      const params = (msg.params ?? {}) as {
        progressToken?: number | string;
        progress?: number;
        total?: number;
        message?: string;
      };
      const token =
        typeof params.progressToken === 'number'
          ? params.progressToken
          : Number(params.progressToken);
      if (Number.isFinite(token)) {
        const p = this.pending.get(token);
        if (p?.onProgress) {
          try {
            p.onProgress({
              progress: params.progress,
              total: params.total,
              message: params.message,
            });
          } catch {
            // ignore progress handler errors
          }
        }
      }
      return;
    }

    if (msg.id == null) return; // other notifications
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    if (!Number.isFinite(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      try {
        pending.signal.removeEventListener('abort', pending.abortHandler);
      } catch {
        // ignore
      }
    }
    this.pending.delete(id);
    if (msg.error) {
      pending.reject(
        new McpError(
          String(msg.error.code ?? 'mcp_error'),
          typeof msg.error.message === 'string' ? msg.error.message : JSON.stringify(msg.error),
          msg.error.data,
        ),
      );
      return;
    }
    pending.resolve(msg.result);
  }

  notify(method: string, params?: unknown): void {
    if (!this.isAlive()) return;
    try {
      this.transport.send({ jsonrpc: '2.0', method, params: params ?? {} });
    } catch {
      // ignore notify failures
    }
  }

  async request(method: string, params?: unknown, opts?: McpCallOptions): Promise<unknown> {
    if (!this.isAlive()) {
      throw new McpError('closed', `MCP session is closed (${this.label})`);
    }
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? this.callTimeoutMs;

    // Build params with optional _meta
    let finalParams: unknown = params ?? {};
    if (opts?.idempotencyKey || opts?.onProgress) {
      const base: Record<string, unknown> =
        finalParams && typeof finalParams === 'object' && !Array.isArray(finalParams)
          ? { ...(finalParams as Record<string, unknown>) }
          : { value: finalParams };
      const prevMeta: Record<string, unknown> =
        base._meta && typeof base._meta === 'object' && !Array.isArray(base._meta)
          ? { ...(base._meta as Record<string, unknown>) }
          : {};
      if (opts.idempotencyKey) prevMeta.idempotencyKey = opts.idempotencyKey;
      if (opts.onProgress) prevMeta.progressToken = id;
      base._meta = prevMeta;
      finalParams = base;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (opts?.signal && abortHandler) {
          try {
            opts.signal.removeEventListener('abort', abortHandler);
          } catch {
            // ignore
          }
        }
        reject(
          new McpError('timeout', `MCP call timed out: ${method}`, {
            method,
            timeoutMs,
            label: this.label,
          }),
        );
      }, timeoutMs);

      let abortHandler: (() => void) | undefined;
      if (opts?.signal) {
        abortHandler = () => {
          const p = this.pending.get(id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(id);
          try {
            this.notify('notifications/cancelled', { requestId: id });
          } catch {
            // ignore
          }
          p.reject(new McpError('cancelled', `MCP call cancelled: ${method}`, { method }));
        };
        if (opts.signal.aborted) {
          clearTimeout(timer);
          reject(new McpError('cancelled', `MCP call cancelled: ${method}`, { method }));
          return;
        }
        opts.signal.addEventListener('abort', abortHandler, { once: true });
      }

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        onProgress: opts?.onProgress,
        abortHandler,
        signal: opts?.signal,
      });

      try {
        this.transport.send({
          jsonrpc: '2.0',
          id,
          method,
          params: finalParams,
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (opts?.signal && abortHandler) {
          try {
            opts.signal.removeEventListener('abort', abortHandler);
          } catch {
            // ignore
          }
        }
        reject(
          e instanceof McpError
            ? e
            : new McpError('transport_error', e instanceof Error ? e.message : String(e)),
        );
      }
    });
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const result = (await this.request('tools/list', {})) as {
      tools?: Array<{ name?: string; description?: string }>;
    };
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools
      .filter((t) => typeof t?.name === 'string' && t.name)
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === 'string' ? t.description : undefined,
      }));
  }

  async call(
    name: string,
    args?: Record<string, unknown>,
    opts?: McpCallOptions,
  ): Promise<unknown> {
    const result = await this.request(
      'tools/call',
      {
        name,
        arguments: args ?? {},
      },
      opts,
    );
    if (result && typeof result === 'object') {
      const r = result as { isError?: boolean; content?: unknown };
      if (r.isError) {
        const text = extractMcpText(result);
        const msg = text || JSON.stringify(result);
        if (
          this.errorHint &&
          /not authenticated|accessibility|permission|-10000/i.test(msg)
        ) {
          throw new Error(`${msg} — ${this.errorHint}`);
        }
        throw new Error(`MCP tool "${name}" failed: ${msg}`);
      }
    }
    try {
      this.onSuccessfulCall?.();
    } catch {
      // ignore
    }
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.failAll(new McpError('closed', 'MCP client closed'));
    try {
      this.transport.close();
    } catch {
      // ignore
    }
  }
}

function extractMcpText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return typeof result === 'string' ? result : '';
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
      parts.push((c as { text: string }).text);
    }
  }
  return parts.join('\n');
}

/** Create a fresh MCP session (one-shot; caller owns close()). */
export async function openSession(cfg: McpTransportConfig): Promise<McpSession> {
  const connectTimeoutMs = cfg.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  let transport: McpTransport;
  try {
    if (cfg.kind === 'stdio') {
      transport = createStdioTransport(cfg);
    } else if (cfg.kind === 'loopback-http') {
      transport = createHttpTransport(cfg);
    } else {
      throw new McpError('bad_config', `Unsupported transport kind: ${(cfg as McpTransportConfig).kind}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw e instanceof McpError
      ? e
      : new Error(appendHint(`${cfg.label} 連線失敗: ${msg}`, cfg.errorHint));
  }

  const session = new SessionImpl(transport, cfg);
  try {
    const initPromise = session.request(
      'initialize',
      {
        protocolVersion: cfg.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'aios-server', version: '1.0.0' },
      },
      { timeoutMs: connectTimeoutMs },
    );
    await initPromise;
    session.notify('notifications/initialized', {});
    return session;
  } catch (e) {
    session.close();
    if (e instanceof McpError && e.code === 'timeout') {
      throw new Error(appendHint(`${cfg.label} initialize 逾時`, cfg.errorHint));
    }
    throw e instanceof Error
      ? e
      : new Error(appendHint(`${cfg.label} 連線失敗: ${String(e)}`, cfg.errorHint));
  }
}

// ── Pooled session manager ───────────────────────────────────────────────────

export class McpSessionManager {
  private readonly sessions = new Map<string, McpSession>();
  private readonly inflight = new Map<string, Promise<McpSession>>();
  /** Consecutive reconnect attempts since last successful call (per key). */
  private readonly reconnectCounts = new Map<string, number>();

  async acquire(key: string, cfg: McpTransportConfig): Promise<McpSession> {
    const existing = this.sessions.get(key);
    if (existing && existing.isAlive()) {
      return existing;
    }
    if (existing) {
      // Dead entry — drop
      this.sessions.delete(key);
      try {
        existing.close();
      } catch {
        // ignore
      }
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const maxReconnects = cfg.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    const count = this.reconnectCounts.get(key) ?? 0;
    // Only bound when we are reconnecting after a prior session existed/crashed
    // or after failed opens. First acquire with count 0 is fine.
    if (count >= maxReconnects) {
      throw new McpError(
        'reconnect_exhausted',
        `MCP session reconnect exhausted for key=${key} after ${maxReconnects} attempts`,
        { key, maxReconnects },
      );
    }

    const connectPromise = this.connectWithBackoff(key, cfg, maxReconnects);
    this.inflight.set(key, connectPromise);
    try {
      const session = await connectPromise;
      return session;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async connectWithBackoff(
    key: string,
    cfg: McpTransportConfig,
    maxReconnects: number,
  ): Promise<McpSession> {
    let lastErr: unknown;
    // Use remaining attempts from current counter
    const already = this.reconnectCounts.get(key) ?? 0;
    const attemptsLeft = Math.max(1, maxReconnects - already);

    for (let i = 0; i < attemptsLeft; i++) {
      if (i > 0) {
        const backoffMs = Math.min(200 * i, 800);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
      this.reconnectCounts.set(key, (this.reconnectCounts.get(key) ?? 0) + 1);
      try {
        const session = await openSession(cfg);
        // Wire success reset + death invalidation
        if (session instanceof SessionImpl) {
          session.onSuccessfulCall = () => {
            this.reconnectCounts.set(key, 0);
          };
        }
        this.sessions.set(key, session);
        // Watch for crash: poll isAlive is awkward; hook via wrapping close path.
        // Session transport onClose already marks not alive; we check on next acquire.
        // Also install a lightweight watcher: when request fails due to exit, next acquire reconnects.
        this.watchSession(key, session);
        return session;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof McpError
      ? lastErr
      : new McpError(
          'connect_failed',
          `MCP connect failed for key=${key}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
          { key },
        );
  }

  private watchSession(key: string, session: McpSession): void {
    // Poll lightly: if session dies, drop from map so next acquire reconnects.
    const interval = setInterval(() => {
      if (!session.isAlive()) {
        clearInterval(interval);
        if (this.sessions.get(key) === session) {
          this.sessions.delete(key);
        }
      }
    }, 200);
    interval.unref?.();
  }

  drop(key: string): void {
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    this.inflight.delete(key);
    this.reconnectCounts.delete(key);
    if (s) {
      try {
        s.close();
      } catch {
        // ignore
      }
    }
  }

  closeAll(): void {
    const keys = [...this.sessions.keys()];
    for (const k of keys) this.drop(k);
    this.inflight.clear();
    this.reconnectCounts.clear();
  }
}

export const mcpSessions = new McpSessionManager();
