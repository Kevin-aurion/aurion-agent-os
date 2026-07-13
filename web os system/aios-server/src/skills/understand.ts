// Read-&-understand pipeline for Skills. Runs a fixed rubric prompt against a
// skill's SKILL.md content through whichever engine CLI is actually
// reachable (Codex preferred as the independent read-only reviewer, Claude
// Code as fallback), asking for STRICT JSON covering capabilities, data
// flows, external calls, irreversible actions, and risks. If no engine can
// be invoked at all, degrades to a heuristic static summary so a skill is
// never stuck in PENDING_UNDERSTANDING. Persists the result onto
// Skill.understanding, flips reviewStatus to AWAITING_USER_CONFIRM, and
// publishes `skill.review_ready` on the WS hub.
import { prisma } from '../lib/db.js';
import { paths } from '../config.js';
import { hub } from '../ws/hub.js';

export interface SkillUnderstanding {
  summary: string;
  capabilities: string[];
  data_read: string[];
  data_written: string[];
  external_calls: string[];
  irreversible_actions: string[];
  risks: string[];
  meta: {
    source: 'engine:codex' | 'engine:claude' | 'heuristic';
    staticFlags?: string[];
  };
}

type RawUnderstanding = Omit<SkillUnderstanding, 'meta'>;

const RUBRIC = `You are auditing a "skill" definition file (SKILL.md, possibly with bundled assets) that may be granted to an autonomous coding/computer-control agent. Read it carefully and report, in STRICT JSON only (no markdown fences, no commentary before or after), exactly this shape:

{
  "summary": string,                // 2-4 sentence plain-English summary of what this skill does
  "capabilities": string[],         // discrete things the skill lets an agent do
  "data_read": string[],            // data/files/services it reads
  "data_written": string[],         // data/files/services it writes or modifies
  "external_calls": string[],       // network calls, APIs, subprocesses, third-party services it invokes
  "irreversible_actions": string[], // actions that cannot be trivially undone (deletes, sends, payments, etc.) — empty array if none
  "risks": string[]                 // concrete risks a human reviewer should weigh before confirming this skill for use
}

Be concrete and specific to the content below; do not invent capabilities that are not evidenced in the text. If a category is genuinely empty, return an empty array for it. Output ONLY the JSON object, nothing else.`;

// ── Tolerant JSON extraction (mirrors engine/runner.ts's looseParseJson) ────

function stripFences(s: string): string {
  return s
    .replace(/^```[a-zA-Z]*\r?\n/, '')
    .replace(/\r?\n```$/, '')
    .trim();
}

function looseParseJson(raw: string): unknown {
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
      // give up — caller degrades to heuristic
    }
  }
  return undefined;
}

function coerceUnderstanding(obj: unknown): RawUnderstanding | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.summary !== 'string') return null;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  return {
    summary: o.summary,
    capabilities: arr(o.capabilities),
    data_read: arr(o.data_read),
    data_written: arr(o.data_written),
    external_calls: arr(o.external_calls),
    irreversible_actions: arr(o.irreversible_actions),
    risks: arr(o.risks),
  };
}

// ── Engine dispatch (best-effort; never throws) ─────────────────────────────

interface EngineFns {
  runClaude?: (opts: { prompt: string; cwd: string; timeoutMs?: number }) => Promise<{ stdout: string }>;
  runCodex?: (opts: { prompt: string; cwd: string; sandbox?: 'read-only' | 'workspace-write'; timeoutMs?: number }) => Promise<{ text: string }>;
}

/**
 * Prefer whatever `../engine/index.js` re-exports (per the engine module's
 * public-surface convention); fall back to the concrete claude.js/codex.js
 * modules directly since index.ts currently only re-exports runAgent et al.
 * Any import failure degrades silently — the caller falls back to heuristics.
 */
async function loadEngineFns(): Promise<EngineFns> {
  const out: EngineFns = {};
  try {
    const idx: any = await import('../engine/index.js');
    if (typeof idx.runClaude === 'function') out.runClaude = idx.runClaude;
    if (typeof idx.runCodex === 'function') out.runCodex = idx.runCodex;
  } catch {
    // engine/index.ts not importable (or doesn't export these) — try direct modules below
  }
  if (!out.runCodex) {
    try {
      const cx: any = await import('../engine/codex.js');
      if (typeof cx.runCodex === 'function') out.runCodex = cx.runCodex;
    } catch {
      // codex engine module unavailable
    }
  }
  if (!out.runClaude) {
    try {
      const cl: any = await import('../engine/claude.js');
      if (typeof cl.runClaude === 'function') out.runClaude = cl.runClaude;
    } catch {
      // claude engine module unavailable
    }
  }
  return out;
}

const ENGINE_TIMEOUT_MS = 5 * 60_000;

async function runViaEngine(contentMd: string): Promise<{ understanding: RawUnderstanding; source: 'engine:codex' | 'engine:claude' } | null> {
  const fns = await loadEngineFns();
  const prompt = `${RUBRIC}\n\n[Skill content under review]\n${contentMd}`;

  if (fns.runCodex) {
    try {
      const res = await fns.runCodex({ prompt, cwd: paths.cache, sandbox: 'read-only', timeoutMs: ENGINE_TIMEOUT_MS });
      const parsed = coerceUnderstanding(looseParseJson(res.text));
      if (parsed) return { understanding: parsed, source: 'engine:codex' };
    } catch {
      // fall through to claude / heuristic
    }
  }
  if (fns.runClaude) {
    try {
      const res = await fns.runClaude({ prompt, cwd: paths.cache, timeoutMs: ENGINE_TIMEOUT_MS });
      const parsed = coerceUnderstanding(looseParseJson(res.stdout));
      if (parsed) return { understanding: parsed, source: 'engine:claude' };
    } catch {
      // fall through to heuristic
    }
  }
  return null;
}

// ── Heuristic fallback (no engine reachable) ────────────────────────────────

function heuristicUnderstanding(contentMd: string, kind: string): RawUnderstanding {
  const headingLines = contentMd
    .split(/\r?\n/)
    .filter((l) => /^#{1,3}\s/.test(l))
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter(Boolean);

  const firstParagraph = contentMd
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#') && !p.startsWith('---'));

  const summary = (firstParagraph ?? '').slice(0, 400) || `Skill of kind ${kind} — no engine CLI was reachable, so this is a heuristic fallback summary; a human review is required.`;

  const dataRead = new Set<string>();
  const dataWritten = new Set<string>();
  const externalCalls = new Set<string>();
  const irreversible = new Set<string>();

  const scan = (re: RegExp, into: Set<string>) => {
    const hit = contentMd.match(re)?.[0];
    if (hit) into.add(hit.trim());
  };
  scan(/\bfetch\s*\(|\baxios\b|\bhttps?:\/\/[^\s)]+/i, externalCalls);
  scan(/\bchild_process\b|\bexec\s*\(|\bspawn\s*\(/i, externalCalls);
  scan(/\bfs\.(writeFile|unlink|rm|rmdir|appendFile)\w*/i, dataWritten);
  scan(/\bfs\.(readFile|readdir|stat)\w*/i, dataRead);
  scan(/\bDELETE\b|\bdrop\s+table\b|\bpermanently\s+delete\b/i, irreversible);
  scan(/\bsend(Email|Message)\b|\bpublish\s*\(/i, irreversible);

  return {
    summary,
    capabilities: headingLines.slice(0, 10),
    data_read: Array.from(dataRead),
    data_written: Array.from(dataWritten),
    external_calls: Array.from(externalCalls),
    irreversible_actions: Array.from(irreversible),
    risks: ['Understanding generated heuristically — no execute/verifier engine CLI was reachable; a human review is strongly advised before confirming this skill.'],
  };
}

// ── Light static check (TOOL_MODULE only): undeclared child_process/network imports ──

const RISKY_IMPORT_RE = /\b(?:require\(\s*['"]|from\s+['"]|import\(\s*['"])(node:child_process|child_process|node:net|net|node:http|http|node:https|https|node:dgram|dgram)['"]/g;
const NETWORK_CALL_RE = /\bfetch\s*\(|\baxios\b|\bXMLHttpRequest\b/;

function staticCheckToolModule(contentMd: string, understanding: RawUnderstanding): string[] {
  const flags: string[] = [];
  const declared = [...understanding.external_calls, ...understanding.capabilities].join(' ').toLowerCase();

  const found = new Set<string>();
  let m: RegExpExecArray | null;
  RISKY_IMPORT_RE.lastIndex = 0;
  while ((m = RISKY_IMPORT_RE.exec(contentMd))) found.add((m[1] as string).replace('node:', ''));

  for (const mod of found) {
    if (!declared.includes(mod)) {
      flags.push(`Static check: skill content references "${mod}" but this is not declared among external_calls/capabilities — verify this is intentional before confirming.`);
    }
  }
  if (NETWORK_CALL_RE.test(contentMd) && !declared.includes('fetch') && !declared.includes('http') && !declared.includes('network') && !declared.includes('axios')) {
    flags.push('Static check: skill content uses fetch/axios/XHR for network calls without a matching declared external_call — verify this is intentional before confirming.');
  }
  return flags;
}

// ── Entrypoint ───────────────────────────────────────────────────────────────

/**
 * Run the read-&-understand pipeline for a skill and persist the result.
 * Returns the understanding object, or null if the skill doesn't exist
 * (deleted/never created). Any downstream persistence error propagates to
 * the caller (route handlers are expected to catch it).
 */
export async function understandSkill(skillId: string): Promise<SkillUnderstanding | null> {
  const skill = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!skill || skill.deletedAt) return null;

  const viaEngine = await runViaEngine(skill.contentMd).catch(() => null);
  const raw: RawUnderstanding = viaEngine ? viaEngine.understanding : heuristicUnderstanding(skill.contentMd, skill.kind);
  const source: SkillUnderstanding['meta']['source'] = viaEngine ? viaEngine.source : 'heuristic';

  const staticFlags = skill.kind === 'TOOL_MODULE' ? staticCheckToolModule(skill.contentMd, raw) : [];
  if (staticFlags.length) raw.risks = Array.from(new Set([...raw.risks, ...staticFlags]));

  const understanding: SkillUnderstanding = {
    ...raw,
    meta: { source, staticFlags: staticFlags.length ? staticFlags : undefined },
  };

  await prisma.skill.update({
    where: { id: skillId },
    data: { understanding: understanding as unknown as object, reviewStatus: 'AWAITING_USER_CONFIRM' },
  });

  hub.publish('skill.review_ready', { skillId, understanding });
  return understanding;
}
