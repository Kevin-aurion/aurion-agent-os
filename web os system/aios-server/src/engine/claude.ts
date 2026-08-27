// Claude Code CLI wrapper — spawns `claude -p` non-interactively (see the
// reference implementation's claude.ts). Exposes a plain call and a
// streaming variant that reports each output line as it arrives, so callers
// can forward it onto the WS hub as `run.log` events.
import { spawn } from 'node:child_process';
import { config } from '../config.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface ExecCliOpts {
  cwd?: string;
  input?: string | null;
  timeoutMs?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** When set, wrap the CLI spawn with `sandbox-exec -f <profile> <cmd> ...`. Opt-in only. */
  sandboxProfilePath?: string;
  /** Cancels the whole spawned CLI process group, including hook/tool children. */
  signal?: AbortSignal;
}

function makeLineSplitter(onLine: (line: string) => void) {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, idx).replace(/\r$/, ''));
        buf = buf.slice(idx + 1);
      }
    },
    flush() {
      if (buf) {
        onLine(buf);
        buf = '';
      }
    },
  };
}

/**
 * Spawn a CLI (no shell), feed optional stdin, collect stdout/stderr, and
 * optionally stream complete lines as they arrive. Never throws on a
 * non-zero exit — callers decide what a bad exit code means.
 */
export function execCli(cmd: string, args: string[], opts: ExecCliOpts = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('CLI execution aborted before spawn'));
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      // Opt-in L6 write sandbox: only wrap when a profile path is provided.
      // Default path (no sandboxProfilePath) is byte-identical to the original spawn.
      const spawnCmd = opts.sandboxProfilePath ? 'sandbox-exec' : cmd;
      const spawnArgs = opts.sandboxProfilePath
        ? ['-f', opts.sandboxProfilePath, cmd, ...args]
        : args;
      child = spawn(spawnCmd, spawnArgs, {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // A dedicated process group lets timeout/abort terminate the CLI plus
        // any hook/MCP children it launched instead of orphaning them.
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const outSplitter = opts.onLine ? makeLineSplitter((l) => opts.onLine!(l, 'stdout')) : null;
    const errSplitter = opts.onLine ? makeLineSplitter((l) => opts.onLine!(l, 'stderr')) : null;
    const terminateGroup = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child when the process group already exited.
        }
      }
      child.kill(signal);
    };
    const scheduleForceKill = () => {
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => terminateGroup('SIGKILL'), 2_000);
    };
    const onAbort = () => {
      aborted = true;
      terminateGroup('SIGTERM');
      scheduleForceKill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateGroup('SIGTERM');
        // Some CLI children keep descriptors open after SIGTERM. A bounded
        // second stage prevents user-facing requests from hanging past their
        // declared timeout.
        scheduleForceKill();
      }, opts.timeoutMs);
    }

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stdout += s;
      outSplitter?.push(s);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stderr += s;
      errSplitter?.push(s);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      outSplitter?.flush();
      errSplitter?.flush();
      resolve({ code: code ?? -1, stdout, stderr, timedOut, aborted });
    });

    if (opts.input != null) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

export interface RunClaudeOpts {
  prompt: string;
  systemAppend?: string; // role prompt + skill manuals, injected via --append-system-prompt
  cwd: string;
  timeoutMs?: number;
  mcpConfig?: string | null;
  fullPermissions?: boolean; // --dangerously-skip-permissions
  disallowedTools?: string[]; // hard tool bans, e.g. ['WebSearch','WebFetch'] (agent restrictions)
  allowedTools?: string[]; // pre-approved tools, e.g. verifier read-only web access
  /** Opt-in L6 write sandbox profile path; forwarded to execCli. */
  sandboxProfilePath?: string;
  signal?: AbortSignal;
  /** Disable user/project Claude customizations for deterministic sandbox runs. */
  safeMode?: boolean;
}

export interface RunClaudeResult {
  stdout: string;
}

export function buildClaudeArgs(opts: RunClaudeOpts): string[] {
  const args = ['-p', opts.prompt, '--output-format', 'text'];
  if (opts.safeMode) args.push('--safe-mode');
  if (opts.systemAppend) args.push('--append-system-prompt', opts.systemAppend);
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig);
  if (opts.fullPermissions) args.push('--dangerously-skip-permissions');
  if (opts.disallowedTools?.length) args.push('--disallowedTools', opts.disallowedTools.join(','));
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
  return args;
}

/** Non-streaming exec: spawns `claude -p ...`, returns the trimmed stdout. */
export async function runClaude(opts: RunClaudeOpts): Promise<RunClaudeResult> {
  const { code, stdout, stderr, timedOut, aborted } = await execCli(config.engines.claudePath, buildClaudeArgs(opts), {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    sandboxProfilePath: opts.sandboxProfilePath,
    signal: opts.signal,
  });
  if (aborted) throw new Error('claude aborted');
  if (timedOut) throw new Error(`claude timed out after ${opts.timeoutMs}ms`);
  if (code !== 0) throw new Error(`claude exit ${code}: ${(stderr || stdout).slice(0, 2000)}`);
  const out = stdout.trim();
  if (!out) throw new Error('claude returned no output');
  return { stdout: out };
}

/** Streaming exec: same as runClaude but calls onLine for each stdout line as it arrives. */
export async function runClaudeStream(opts: RunClaudeOpts & { onLine: (line: string) => void }): Promise<RunClaudeResult> {
  const { code, stdout, stderr, timedOut, aborted } = await execCli(config.engines.claudePath, buildClaudeArgs(opts), {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    sandboxProfilePath: opts.sandboxProfilePath,
    onLine: (line, stream) => {
      if (stream === 'stdout') opts.onLine(line);
    },
    signal: opts.signal,
  });
  if (aborted) throw new Error('claude aborted');
  if (timedOut) throw new Error(`claude timed out after ${opts.timeoutMs}ms`);
  if (code !== 0) throw new Error(`claude exit ${code}: ${(stderr || stdout).slice(0, 2000)}`);
  const out = stdout.trim();
  if (!out) throw new Error('claude returned no output');
  return { stdout: out };
}
