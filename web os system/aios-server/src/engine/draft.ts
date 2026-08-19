// Shared "ask an engine for free-form text" helper used by skill build and
// workflow compose. Never throws — callers degrade to a local fallback.
import { paths } from '../config.js';

export type DraftEngine = 'CLAUDE_CODE' | 'CODEX' | 'GROK';

/**
 * Run a one-shot prompt against the chosen engine adapter and return the
 * raw text output, or null if the engine is unavailable / errors out.
 */
export async function draftWithEngine(
  engine: DraftEngine,
  prompt: string,
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<string | null> {
  const cwd = opts?.cwd ?? paths.cache;
  const timeoutMs = opts?.timeoutMs ?? 5 * 60_000;
  try {
    if (engine === 'CODEX') {
      const mod: any = await import('./codex.js');
      return (await mod.runCodex({ prompt, cwd, sandbox: 'read-only', timeoutMs }))?.text ?? null;
    }
    if (engine === 'GROK') {
      const mod: any = await import('./grok.js');
      return (await mod.runGrok({ prompt, cwd, timeoutMs }))?.stdout ?? null;
    }
    const mod: any = await import('./claude.js');
    return (await mod.runClaude({ prompt, cwd, timeoutMs }))?.stdout ?? null;
  } catch {
    return null;
  }
}

function stripFences(s: string): string {
  return s
    .replace(/^```[a-zA-Z]*\r?\n/, '')
    .replace(/\r?\n```$/, '')
    .trim();
}

/**
 * Tolerant JSON extraction: strip optional markdown fences, then parse;
 * on failure try the span from the first `{` to the last `}`.
 * Returns undefined when nothing parseable is found.
 */
export function looseParseJson(raw: string): unknown {
  const t = stripFences(raw);
  try {
    return JSON.parse(t);
  } catch {
    // fall through to balanced-bracket extraction
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      // give up
    }
  }
  return undefined;
}
