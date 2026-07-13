// Grok Build CLI (xAI) engine adapter. Used as a FAST skill builder and
// cross-model verifier; Claude Code stays the primary executor.
//
// Headless contract (verified locally, grok 0.2.93):
//   grok -p "<prompt>" --output-format json --always-approve --cwd <dir>
// → stdout JSON: { text, stopReason, sessionId, requestId, thought }
// `--resume <sessionId>` continues a session (verifier keeps its own memory
// across rounds, like `codex exec resume`). `--rules` appends to the system
// prompt. No --timeout flag exists — execCli enforces ours.
import { config } from '../config.js';
import { execCli } from './claude.js';

export interface RunGrokOpts {
  prompt: string;
  /** Extra rules appended to the system prompt (like claude --append-system-prompt). */
  systemAppend?: string;
  cwd: string;
  timeoutMs?: number;
  /** Resume an existing Grok session (verifier thread memory across rounds). */
  resumeSessionId?: string | null;
  /** Hard-disable the web search / web fetch tools (agent restriction). */
  disableWebSearch?: boolean;
  onLine?: (line: string) => void;
}

export interface RunGrokResult {
  stdout: string;
  /** Session id for --resume on subsequent rounds. */
  sessionId: string | null;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function runGrok(opts: RunGrokOpts): Promise<RunGrokResult> {
  const args = ['--no-auto-update', '-p', opts.prompt, '--output-format', 'json', '--always-approve', '--cwd', opts.cwd];
  if (opts.systemAppend) args.push('--rules', opts.systemAppend);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.disableWebSearch) args.push('--disable-web-search');

  const res = await execCli(config.engines.grokPath, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onLine: opts.onLine ? (line) => opts.onLine!(line) : undefined,
  });

  if (res.timedOut) throw new Error(`grok timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
  if (res.code !== 0) {
    throw new Error(`grok exited ${res.code}: ${(res.stderr || res.stdout).slice(0, 400)}`);
  }

  // Prefer the JSON envelope; fall back to raw stdout if parsing fails.
  try {
    const parsed = JSON.parse(res.stdout) as { text?: string; sessionId?: string };
    return { stdout: (parsed.text ?? '').trim(), sessionId: parsed.sessionId ?? null };
  } catch {
    return { stdout: res.stdout.trim(), sessionId: null };
  }
}
