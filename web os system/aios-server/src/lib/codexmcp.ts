// Minimal stdio JSON-RPC MCP client for Codex App MCP servers
// (Computer Use + Record & Replay event-stream). No extra dependencies:
// node:child_process + hand-rolled newline-delimited JSON-RPC 2.0.
//
// Framing note (verified 2026-07): SkyComputerUseClient speaks **newline-
// delimited** JSON on stdio, not LSP Content-Length headers.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import readline from 'node:readline';
import { config } from '../config.js';

export interface McpClient {
  listTools(): Promise<Array<{ name: string; description?: string }>>;
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

const DEFAULT_CALL_TIMEOUT_MS = 12_000;
const CONNECT_TIMEOUT_MS = 10_000;

const PERMISSION_HINT =
  '請確認 Codex Computer Use 已安裝、且已授予系統輔助使用權限（系統設定 → 隱私權與安全性 → 輔助使用）。';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

class StdioMcpClient implements McpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  private rl: readline.Interface | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));
    child.stderr.on('data', () => {
      // Keep stderr drained so the child cannot block on a full pipe.
    });
    child.on('exit', (code, signal) => {
      if (this.closed) return;
      this.failAll(
        new Error(
          `MCP process exited (code=${code}, signal=${signal}). ${PERMISSION_HINT}`,
        ),
      );
    });
    child.on('error', (err) => {
      this.failAll(new Error(`MCP process error: ${err.message}. ${PERMISSION_HINT}`));
    });
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
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
    if (msg.id == null) return; // notifications — ignore
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (msg.error) {
      const detail =
        typeof msg.error.message === 'string'
          ? msg.error.message
          : JSON.stringify(msg.error);
      pending.reject(new Error(`MCP error: ${detail}`));
      return;
    }
    pending.resolve(msg.result);
  }

  private send(method: string, params?: unknown, isNotification = false): Promise<unknown> | void {
    if (this.closed) {
      return Promise.reject(new Error('MCP client is closed'));
    }
    if (isNotification) {
      const body = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} });
      this.child.stdin.write(body + '\n');
      return;
    }
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP call timed out: ${method}. ${PERMISSION_HINT}`,
          ),
        );
      }, DEFAULT_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(body + '\n');
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    return (await this.send(method, params, false)) as unknown;
  }

  notify(method: string, params?: unknown): void {
    void this.send(method, params, true);
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

  async call(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const result = await this.request('tools/call', {
      name,
      arguments: args ?? {},
    });
    // Surface MCP isError content as a thrown Error with readable permission hint.
    if (result && typeof result === 'object') {
      const r = result as { isError?: boolean; content?: unknown };
      if (r.isError) {
        const text = extractMcpText(result);
        const msg = text || JSON.stringify(result);
        if (/not authenticated|accessibility|permission|-10000/i.test(msg)) {
          throw new Error(`${msg} — ${PERMISSION_HINT}`);
        }
        throw new Error(`MCP tool "${name}" failed: ${msg}`);
      }
    }
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('MCP client closed'));
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
    // Force-kill if still alive shortly after.
    setTimeout(() => {
      try {
        if (!this.child.killed) this.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 500).unref?.();
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

function assertExecutable(bin: string, label: string): void {
  try {
    accessSync(bin, fsConstants.X_OK);
  } catch {
    throw new Error(
      `${label} 找不到或不可執行: ${bin}。${PERMISSION_HINT}`,
    );
  }
}

async function connectMcp(opts: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  label: string;
}): Promise<StdioMcpClient> {
  assertExecutable(opts.command, opts.label);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  } catch (e) {
    throw new Error(
      `無法啟動 ${opts.label}: ${e instanceof Error ? e.message : String(e)}。${PERMISSION_HINT}`,
    );
  }

  const client = new StdioMcpClient(child);

  try {
    const initPromise = client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aios-server', version: '1.0.0' },
    });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${opts.label} initialize 逾時。${PERMISSION_HINT}`)),
        CONNECT_TIMEOUT_MS,
      );
    });
    await Promise.race([initPromise, timeout]);
    client.notify('notifications/initialized', {});
    return client;
  } catch (e) {
    client.close();
    throw e instanceof Error
      ? e
      : new Error(`${opts.label} 連線失敗: ${String(e)}。${PERMISSION_HINT}`);
  }
}

/** Connect to Codex Computer Use MCP (10 desktop automation tools). */
export async function connectComputerUse(): Promise<McpClient> {
  return connectMcp({
    command: config.codex.computerUseBin,
    args: ['mcp'],
    cwd: config.codex.computerUseDir,
    label: 'Codex Computer Use',
  });
}

/** Connect to Record & Replay event-stream MCP (start/status/stop). */
export async function connectEventStream(): Promise<McpClient> {
  return connectMcp({
    command: config.codex.recordLauncher,
    args: ['event-stream', 'mcp'],
    cwd: config.codex.recordPluginDir,
    env: { CODEX_HOME: config.codex.home },
    label: 'Record & Replay (event-stream)',
  });
}

/**
 * List tools and ensure every required name is present.
 * Throws a clear error on version drift (missing tools).
 */
export async function assertToolsPresent(c: McpClient, required: string[]): Promise<void> {
  const tools = await c.listTools();
  const have = new Set(tools.map((t) => t.name));
  const missing = required.filter((n) => !have.has(n));
  if (missing.length) {
    throw new Error(
      `MCP 工具清單與預期不符（版本漂移？）缺少: ${missing.join(', ')}。` +
        `實際工具: ${[...have].sort().join(', ') || '(none)'}。${PERMISSION_HINT}`,
    );
  }
}

/** Canonical Computer Use tool set (ADR 0005). */
export const COMPUTER_USE_TOOLS = [
  'list_apps',
  'get_app_state',
  'click',
  'perform_secondary_action',
  'set_value',
  'select_text',
  'scroll',
  'drag',
  'press_key',
  'type_text',
] as const;

/** Canonical Record & Replay tool set (ADR 0005). */
export const EVENT_STREAM_TOOLS = [
  'event_stream_start',
  'event_stream_status',
  'event_stream_stop',
] as const;
