// Codex CLI wrapper — spawns `codex exec` (see the reference lazyoffice
// engine's codex.ts). Supports the JSON event stream, thread-id extraction
// for verifier-thread resume across rounds, and the deterministic
// isApproved() oracle shared by every verify call in the runner (fail-closed).
import { config } from '../config.js';
import { execCli } from './claude.js';

export interface RunCodexOpts {
  prompt: string; // piped over stdin
  cwd: string;
  timeoutMs?: number;
  resumeThreadId?: string | null; // set => `codex exec resume <id>` instead of a fresh thread
  sandbox?: 'read-only' | 'workspace-write';
  onLine?: (line: string) => void; // raw --json lines, as they arrive
  /** Opt-in L6 write sandbox profile path; forwarded to execCli (not codex --sandbox). */
  sandboxProfilePath?: string;
}

export interface RunCodexResult {
  stdout: string;
  text: string; // last agent_message text extracted from the JSON stream
  threadId: string | null;
}

function extractThreadId(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t);
      if (e.type === 'thread.started' && e.thread_id) return e.thread_id;
    } catch {
      // not a JSON line, skip
    }
  }
  return null;
}

function extractMessage(stdout: string): string {
  const msgs: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t);
      if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') {
        msgs.push(e.item.text);
      }
    } catch {
      // not a JSON line, skip
    }
  }
  return msgs.length ? msgs[msgs.length - 1]!.trim() : '';
}

/**
 * Spawn `codex exec` (round 1) or `codex exec resume <threadId>` (round 2+).
 * The resume subcommand doesn't accept --sandbox on this CLI version, so the
 * sandbox flag is only sent on a fresh thread.
 */
export async function runCodex(opts: RunCodexOpts): Promise<RunCodexResult> {
  const isResume = opts.resumeThreadId != null;
  const args = isResume
    ? ['exec', 'resume', opts.resumeThreadId as string, '--json', '--skip-git-repo-check', '-']
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', opts.sandbox ?? 'workspace-write', '-'];

  const { code, stdout, stderr, timedOut } = await execCli(config.engines.codexPath, args, {
    cwd: opts.cwd,
    input: opts.prompt,
    timeoutMs: opts.timeoutMs,
    sandboxProfilePath: opts.sandboxProfilePath,
    onLine: opts.onLine ? (line, stream) => { if (stream === 'stdout') opts.onLine!(line); } : undefined,
  });
  if (timedOut) throw new Error(`codex timed out after ${opts.timeoutMs}ms`);
  if (code !== 0) throw new Error(`codex exit ${code}: ${(stderr || stdout).slice(0, 2000)}`);

  const threadId = opts.resumeThreadId ?? extractThreadId(stdout);
  const text = extractMessage(stdout);
  if (!text) throw new Error(`codex returned no parsable message. stdout head: ${stdout.slice(0, 500)}`);
  return { stdout, text, threadId };
}

// Verdict must be an independent "APPROVED" line right after "## Verdict".
// The line right after `## Verdict` must be EXACTLY "APPROVED" (guards
// against the model echoing the template "APPROVED (or) ISSUES FOUND").
const APPROVED_RE = /##\s*Verdict\s*\r?\n\s*APPROVED\s*[.!。]?\s*(?:\r?\n|$)/i;
// Any line starting with rejection wording anywhere => never approved
// (checked before any APPROVED match — fail-closed).
const REJECTED_RE = /^\s*(?:ISSUES\s+FOUND|REMAINING\s+ISSUES)\b/im;

/**
 * Deterministic approval oracle (fail-closed):
 * 1) Standard format: an independent "APPROVED" line right after "## Verdict".
 * 2) Tolerant fallback (format drift common on resume rounds): no rejection
 *    wording anywhere, and the last non-empty line is a bare "APPROVED".
 *    A bare APPROVED appearing mid-sentence or mid-paragraph does not count.
 */
export function isApproved(text: string): boolean {
  if (REJECTED_RE.test(text)) return false;
  if (APPROVED_RE.test(text)) return true;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? '';
  return /^APPROVED[.!。]?$/.test(last);
}
