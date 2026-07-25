// Record & Replay bridge: start/status/stop via Codex event-stream MCP,
// then import Codex-produced SKILL.md into our Skill table (origin=RECORDED).
// We never parse events.jsonl ourselves — skill synthesis is delegated to
// Codex (record-and-replay + skill-creator). Import always goes through
// redactSecrets + understandSkill and never auto-CONFIRMs.
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { config, paths } from '../config.js';
import { prisma } from './db.js';
import { errors } from './http.js';
import { slugify } from './slug.js';
import { redactSecrets } from '../memory/redactor.js';
import { runCodex } from '../engine/codex.js';
import { understandSkill } from '../skills/understand.js';
import {
  connectEventStream,
  assertToolsPresent,
  EVENT_STREAM_TOOLS,
  type McpClient,
} from './codexmcp.js';

const CODEX_SKILL_TIMEOUT_MS = 10 * 60_000;

function parseFrontmatter(md: string): { meta: Record<string, unknown>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const raw = m[1] ?? '';
  const meta: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) meta[key] = val;
  }
  return { meta, body: m[2] ?? '' };
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base || 'recorded-skill';
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.skill.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function writeSkillFile(slug: string, contentMd: string): Promise<void> {
  const dest = path.join(paths.skills, slug, 'SKILL.md');
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, contentMd, 'utf8');
}

async function ensureAgentSkillLink(agentId: string, skillId: string): Promise<void> {
  await prisma.agentSkill.upsert({
    where: { agentId_skillId: { agentId, skillId } },
    create: { agentId, skillId },
    update: {},
  });
}

/** Best-effort extract of metadata/events paths from MCP tool results. */
export function extractRecordingPaths(raw: unknown): {
  metadataPath?: string;
  eventsPath?: string;
} {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  const metadataPath =
    text.match(/(?:metadata(?:Path)?|session\.json)["'\s:=]+([^\s"',}]+\.json)/i)?.[1] ??
    text.match(/(\/[^\s"',]*session\.json)/i)?.[1] ??
    text.match(/(\/[^\s"',]*metadata\.json)/i)?.[1];
  const eventsPath =
    text.match(/(?:events(?:Path)?|events\.jsonl)["'\s:=]+([^\s"',}]+\.jsonl)/i)?.[1] ??
    text.match(/(\/[^\s"',]*events\.jsonl)/i)?.[1];

  // Also walk plain objects for common keys.
  let metaFromObj: string | undefined;
  let eventsFromObj: string | undefined;
  const walk = (v: unknown, depth = 0): void => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') {
      if (!metaFromObj && /session\.json|metadata\.json$/i.test(v)) metaFromObj = v;
      if (!eventsFromObj && /events\.jsonl$/i.test(v)) eventsFromObj = v;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const [k, val] of Object.entries(o)) {
        if (typeof val === 'string') {
          if (!metaFromObj && /metadata|session/i.test(k) && val.includes('/')) metaFromObj = val;
          if (!eventsFromObj && /events/i.test(k) && val.includes('/')) eventsFromObj = val;
        }
        walk(val, depth + 1);
      }
    }
  };
  walk(raw);

  return {
    metadataPath: metadataPath ?? metaFromObj,
    eventsPath: eventsPath ?? eventsFromObj,
  };
}

async function withEventStream<T>(fn: (c: McpClient) => Promise<T>): Promise<T> {
  const client = await connectEventStream();
  try {
    await assertToolsPresent(client, [...EVENT_STREAM_TOOLS]);
    return await fn(client);
  } finally {
    client.close();
  }
}

/** Start (or re-join) a Record & Replay session via event_stream_start. */
export async function startRecording(): Promise<{ sessionActive: boolean; raw: unknown }> {
  return withEventStream(async (c) => {
    const raw = await c.call('event_stream_start', {});
    // Successful start (or re-join of an active session) ⇒ session is active.
    return { sessionActive: true, raw };
  });
}

/** Readonly status probe — safe; does not start a recording. */
export async function recordingStatus(): Promise<unknown> {
  return withEventStream(async (c) => c.call('event_stream_status', {}));
}

/** Stop the active recording and best-effort extract product paths. */
export async function stopRecording(): Promise<{
  metadataPath?: string;
  eventsPath?: string;
  raw: unknown;
}> {
  return withEventStream(async (c) => {
    const raw = await c.call('event_stream_stop', {});
    const pathsFound = extractRecordingPaths(raw);
    return { ...pathsFound, raw };
  });
}

/**
 * Import a SKILL.md file into our Skill table as origin=RECORDED.
 * Applies redactSecrets, runs understandSkill → AWAITING_USER_CONFIRM.
 * Never sets CONFIRMED.
 */
export async function importSkillFromMarkdown(
  mdPath: string,
  agentId: string,
  createdBy: string,
): Promise<{ skillId: string; reviewStatus: string }> {
  const agent = await prisma.agent.findFirst({ where: { id: agentId, deletedAt: null } });
  if (!agent) throw errors.notFound('Agent not found');

  let rawMd: string;
  try {
    rawMd = await readFile(mdPath, 'utf8');
  } catch (e) {
    throw errors.badRequest(
      `無法讀取 SKILL.md: ${mdPath} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!rawMd.trim()) throw errors.badRequest('SKILL.md is empty');

  const contentMd = redactSecrets(rawMd);
  const { meta } = parseFrontmatter(contentMd);
  const nameFromMeta = typeof meta.name === 'string' ? meta.name.trim() : '';
  const name =
    nameFromMeta ||
    path.basename(path.dirname(mdPath)) ||
    'recorded-skill';

  const id = ulid();
  const slug = await uniqueSlug(slugify(name));
  await writeSkillFile(slug, contentMd);

  await prisma.skill.create({
    data: {
      id,
      slug,
      name,
      origin: 'RECORDED',
      kind: 'COMPUTER_CONTROL',
      contentMd,
      generator: 'record-and-replay',
      reviewStatus: 'PENDING_UNDERSTANDING',
      executionEnv: 'DESKTOP_APP',
    },
  });

  // Link as draft so the agent training UI can surface it (mount still requires CONFIRMED).
  await ensureAgentSkillLink(agentId, id);

  const understanding = await understandSkill(id);
  if (!understanding) throw errors.notFound('Skill disappeared during understand');

  const skill = await prisma.skill.findUnique({ where: { id } });
  if (!skill || skill.deletedAt) throw errors.notFound('Skill not found after understand');

  // Hard guard: this path must never auto-confirm.
  if (skill.reviewStatus === 'CONFIRMED') {
    throw errors.internal('recorded skill import must not auto-confirm');
  }

  void createdBy; // accepted for call-site / future audit; Skill has no createdBy column.

  return { skillId: skill.id, reviewStatus: skill.reviewStatus };
}

/** Parse skill directory name / SKILL.md path out of Codex agent text. */
function parseSkillPathsFromCodexText(text: string): { skillDirName?: string; skillMdPath?: string } {
  const skillMdPath =
    text.match(/((?:\/|~\/)[^\s`'"\]]+\/SKILL\.md)/i)?.[1] ??
    text.match(/(~\/\.codex\/skills\/[^\s`'"\]]+\/SKILL\.md)/i)?.[1];
  const skillDirName =
    text.match(/(?:skill(?:\s+directory)?(?:\s+name)?|created skill)\s*[:=]\s*[`"]?([A-Za-z0-9._-]+)/i)?.[1] ??
    (skillMdPath
      ? path.basename(path.dirname(skillMdPath.replace(/^~\//, `${process.env.HOME ?? ''}/`)))
      : undefined);
  return { skillDirName, skillMdPath };
}

async function resolveImportedSkillMdPath(
  codexText: string,
  beforeMs: number,
): Promise<string> {
  const { skillMdPath, skillDirName } = parseSkillPathsFromCodexText(codexText);
  const home = config.codex.home;
  const skillsRoot = path.join(home, 'skills');

  if (skillMdPath) {
    const expanded = skillMdPath.startsWith('~/')
      ? path.join(process.env.HOME ?? home, skillMdPath.slice(2))
      : skillMdPath;
    try {
      await stat(expanded);
      return expanded;
    } catch {
      // fall through to scan
    }
  }

  if (skillDirName && skillDirName !== '.system') {
    const candidate = path.join(skillsRoot, skillDirName, 'SKILL.md');
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // fall through
    }
  }

  // Scan ~/.codex/skills for newest SKILL.md created after we asked Codex.
  let newest: { p: string; mtime: number } | null = null;
  let entries: string[] = [];
  try {
    entries = await readdir(skillsRoot);
  } catch {
    throw errors.internal(`找不到 Codex skills 目錄: ${skillsRoot}`);
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const p = path.join(skillsRoot, name, 'SKILL.md');
    try {
      const st = await stat(p);
      const mtime = st.mtimeMs;
      if (mtime + 1000 < beforeMs) continue; // only post-prompt artifacts (1s slack)
      if (!newest || mtime > newest.mtime) newest = { p, mtime };
    } catch {
      // skip
    }
  }
  if (newest) return newest.p;

  throw errors.internal(
    'Codex 未回報可匯入的 SKILL.md 路徑，且 ~/.codex/skills/ 沒有找到新建立的技能。' +
      '請確認 record-and-replay 與 skill-creator 可用。',
  );
}

/**
 * After a recording has stopped: ask Codex to turn it into a skill, then import.
 * Does not parse events.jsonl. Never auto-CONFIRMs.
 */
export async function buildSkillFromRecording(args: {
  agentId: string;
  createdBy: string;
  hint?: string;
  metadataPath?: string;
  eventsPath?: string;
}): Promise<{ skillId: string; reviewStatus: string }> {
  const agent = await prisma.agent.findFirst({ where: { id: args.agentId, deletedAt: null } });
  if (!agent) throw errors.notFound('Agent not found');

  // Prefer CODEX-engine agents for recorded skills (ADR 0005); still allow import
  // if FDE routes a non-CODEX agent — mount gate will block later.
  const meta = args.metadataPath ?? '(unknown — check most recent Record & Replay session)';
  const events = args.eventsPath ?? '(unknown — check most recent Record & Replay session)';
  const hintLine = args.hint?.trim() ? `\nUser hint: ${args.hint.trim()}` : '';

  const prompt = [
    'The Record & Replay recording has just been stopped.',
    `Metadata path: ${meta}`,
    `Events path: ${events}`,
    hintLine,
    '',
    'Using your record-and-replay skill and the skill-creator skill',
    '(~/.codex/skills/.system/skill-creator), turn this recording into a reusable skill.',
    'Do not invent steps that were not recorded. Prefer stable app/window/control targets',
    'over raw coordinates. Never embed passwords, OTP codes, or API keys in the skill.',
    '',
    'When done, report clearly:',
    '1) the skill directory name under ~/.codex/skills/',
    '2) the absolute path to the created SKILL.md',
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  const beforeMs = Date.now();
  let codexText: string;
  try {
    const result = await runCodex({
      prompt,
      cwd: config.codex.home,
      sandbox: 'workspace-write',
      timeoutMs: CODEX_SKILL_TIMEOUT_MS,
    });
    codexText = result.text || result.stdout;
  } catch (e) {
    throw errors.internal(
      `Codex 產生技能失敗: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const mdPath = await resolveImportedSkillMdPath(codexText, beforeMs);
  return importSkillFromMarkdown(mdPath, args.agentId, args.createdBy);
}
