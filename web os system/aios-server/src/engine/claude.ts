// Claude Code CLI wrapper — spawns `claude -p` non-interactively (see the
// reference lazyoffice engine's claude.ts). Exposes a plain call and a
// streaming variant that reports each output line as it arrives, so callers
// can forward it onto the WS hub as `run.log` events.
import { spawn } from 'node:child_process';
import { config } from '../config.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecCliOpts {
  cwd?: string;
  input?: string | null;
  timeoutMs?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** When set, wrap the CLI spawn with `sandbox-exec -f <profile> <cmd> ...`. Opt-in only. */
  sandboxProfilePath?: string;
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
    let child: ReturnType<typeof spawn>;
    try {
      // Opt-in L6 write sandbox: only wrap when a profile path is provided.
      // Default path (no sandboxProfilePath) is byte-identical to the original spawn.
      const spawnCmd = opts.sandboxProfilePath ? 'sandbox-exec' : cmd;
      const spawnArgs = opts.sandboxProfilePath
        ? ['-f', opts.sandboxProfilePath, cmd, ...args]
        : args;
      child = spawn(spawnCmd, spawnArgs, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const outSplitter = opts.onLine ? makeLineSplitter((l) => opts.onLine!(l, 'stdout')) : null;
    const errSplitter = opts.onLine ? makeLineSplitter((l) => opts.onLine!(l, 'stderr')) : null;

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
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
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      outSplitter?.flush();
      errSplitter?.flush();
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
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
}

export interface RunClaudeResult {
  stdout: string;
}

function buildClaudeArgs(opts: RunClaudeOpts): string[] {
  const args = ['-p', opts.prompt, '--output-format', 'text'];
  if (opts.systemAppend) args.push('--append-system-prompt', opts.systemAppend);
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig);
  if (opts.fullPermissions) args.push('--dangerously-skip-permissions');
  if (opts.disallowedTools?.length) args.push('--disallowedTools', opts.disallowedTools.join(','));
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
  return args;
}

/** Non-streaming exec: spawns `claude -p ...`, returns the trimmed stdout. */
export async function runClaude(opts: RunClaudeOpts): Promise<RunClaudeResult> {
  const { code, stdout, stderr, timedOut } = await execCli(config.engines.claudePath, buildClaudeArgs(opts), {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    sandboxProfilePath: opts.sandboxProfilePath,
  });
  if (timedOut) throw new Error(`claude timed out after ${opts.timeoutMs}ms`);
  if (code !== 0) throw new Error(`claude exit ${code}: ${(stderr || stdout).slice(0, 2000)}`);
  const out = stdout.trim();
  if (!out) throw new Error('claude returned no output');
  return { stdout: out };
}

/** Streaming exec: same as runClaude but calls onLine for each stdout line as it arrives. */
export async function runClaudeStream(opts: RunClaudeOpts & { onLine: (line: string) => void }): Promise<RunClaudeResult> {
  const { code, stdout, stderr, timedOut } = await execCli(config.engines.claudePath, buildClaudeArgs(opts), {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    sandboxProfilePath: opts.sandboxProfilePath,
    onLine: (line, stream) => {
      if (stream === 'stdout') opts.onLine(line);
    },
  });
  if (timedOut) throw new Error(`claude timed out after ${opts.timeoutMs}ms`);
  if (code !== 0) throw new Error(`claude exit ${code}: ${(stderr || stdout).slice(0, 2000)}`);
  const out = stdout.trim();
  if (!out) throw new Error('claude returned no output');
  return { stdout: out };
}
