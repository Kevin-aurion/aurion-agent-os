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
import { allowWrite, assertWriteEnabled } from './stopwrite.js';
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
import { hub } from '../ws/hub.js';

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
  const safeHint = args.hint?.trim() ? redactSecrets(args.hint.trim()) : '';
  const hintLine = safeHint ? `\nUser hint: ${safeHint}` : '';

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

// ── Durable RecordingService (server-owned sessions, opaque ids) ─────────────

export interface RecordingDeps {
  startRecording: typeof startRecording;
  recordingStatus: typeof recordingStatus;
  stopRecording: typeof stopRecording;
  buildSkillFromRecording: typeof buildSkillFromRecording;
}

/** Safe client-facing session view — NEVER includes metadataPath/eventsPath. */
export interface SafeRecordingSession {
  id: string;
  agentId: string | null;
  status: string;
  artifactId: string | null;
  skillId: string | null;
  createdAt: Date;
  stoppedAt: Date | null;
  compiledAt: Date | null;
}

function toSafeSession(row: {
  id: string;
  agentId: string | null;
  status: string;
  artifactId: string | null;
  skillId: string | null;
  createdAt: Date;
  stoppedAt: Date | null;
  compiledAt: Date | null;
}): SafeRecordingSession {
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    artifactId: row.artifactId,
    skillId: row.skillId,
    createdAt: row.createdAt,
    stoppedAt: row.stoppedAt,
    compiledAt: row.compiledAt,
  };
}

function publishProgress(userId: string, payload: Record<string, unknown>): void {
  try {
    hub.publishToUser(userId, 'recording.progress', payload);
  } catch (e) {
    console.warn('[recording] progress publish failed (fail-safe):', e);
  }
}

/**
 * Server-owned durable recording sessions. Clients receive only opaque ids;
 * real artifact paths stay on the host. Injectable deps so tests can drive
 * without live Computer Use (ADR 0005 tools/call timeouts).
 */
export class RecordingService {
  /** Host-global single active recorder (in-memory). */
  private activeSessionId: string | null = null;

  constructor(
    private readonly deps: RecordingDeps = {
      startRecording,
      recordingStatus,
      stopRecording,
      buildSkillFromRecording,
    },
  ) {}

  /**
   * Mark non-terminal sessions INTERRUPTED after process restart.
   * Fail-safe at startup: DB errors are logged, never fatal.
   */
  async recoverInterrupted(): Promise<number> {
    if (!allowWrite('recording')) return 0;
    this.activeSessionId = null;
    try {
      const result = await prisma.recordingSession.updateMany({
        where: { status: { in: ['RECORDING', 'COMPILING'] } },
        data: { status: 'INTERRUPTED', note: 'server restart' },
      });
      return result.count;
    } catch (e) {
      console.warn('[recording] recoverInterrupted failed (fail-safe):', e);
      return 0;
    }
  }

  async start(
    userId: string,
    agentId: string,
  ): Promise<{ sessionId: string; agentId: string; status: string; raw?: unknown }> {
    assertWriteEnabled('recording');
    // Host-global single active recorder.
    if (this.activeSessionId) {
      const active = await prisma.recordingSession.findUnique({
        where: { id: this.activeSessionId },
      });
      if (active && active.status === 'RECORDING') {
        if (active.userId !== userId) {
          throw errors.conflict('另一位使用者正在錄製，請稍後再試');
        }
        if (active.agentId !== agentId) {
          throw errors.conflict('目前錄製已綁定另一位 Agent，請先結束該次錄製');
        }
        // Idempotent re-join for the same user.
        let raw: unknown;
        try {
          const r = await this.deps.startRecording();
          raw = r.raw;
        } catch {
          // Re-join probe is best-effort; session row is still authoritative.
        }
        return { sessionId: active.id, agentId, status: 'RECORDING', raw };
      }
      // Stale in-memory pointer — clear and continue.
      this.activeSessionId = null;
    }

    // Also check DB for any RECORDING session owned by another user (host-global).
    const otherActive = await prisma.recordingSession.findFirst({
      where: { status: 'RECORDING', userId: { not: userId } },
      orderBy: { createdAt: 'desc' },
    });
    if (otherActive) {
      throw errors.conflict('另一位使用者正在錄製，請稍後再試');
    }

    // Same user already RECORDING in DB (e.g. after partial restart of in-memory only).
    const ownActive = await prisma.recordingSession.findFirst({
      where: { status: 'RECORDING', userId },
      orderBy: { createdAt: 'desc' },
    });
    if (ownActive) {
      if (ownActive.agentId !== agentId) {
        throw errors.conflict('目前錄製已綁定另一位 Agent，請先結束該次錄製');
      }
      this.activeSessionId = ownActive.id;
      let raw: unknown;
      try {
        const r = await this.deps.startRecording();
        raw = r.raw;
      } catch {
        // best-effort
      }
      return { sessionId: ownActive.id, agentId, status: 'RECORDING', raw };
    }

    // Supersede prior uncompiled stopped captures so a fresh recording is required
    // (matches the previous Map.delete(userId) on start).
    await prisma.recordingSession.updateMany({
      where: { userId, status: 'STOPPED' },
      data: { status: 'INTERRUPTED', note: 'superseded by new recording' },
    });

    const id = ulid();
    await prisma.recordingSession.create({
      data: {
        id,
        userId,
        agentId,
        status: 'RECORDING',
      },
    });
    // Claim before the async MCP call so two concurrent starts cannot both pass.
    this.activeSessionId = id;

    try {
      const result = await this.deps.startRecording();
      publishProgress(userId, { sessionId: id, status: 'RECORDING' });
      return { sessionId: id, agentId, status: 'RECORDING', raw: result.raw };
    } catch (e) {
      await prisma.recordingSession.update({
        where: { id },
        data: {
          status: 'FAILED',
          note: e instanceof Error ? e.message : String(e),
        },
      });
      if (this.activeSessionId === id) this.activeSessionId = null;
      throw e;
    }
  }

  async status(
    userId: string,
    sessionId?: string,
  ): Promise<{ session: SafeRecordingSession | null; live?: unknown }> {
    let row;
    if (sessionId) {
      row = await prisma.recordingSession.findUnique({ where: { id: sessionId } });
      if (!row) return { session: null };
      if (row.userId !== userId) {
        throw errors.forbidden('無權存取此錄製工作階段');
      }
    } else {
      row = await prisma.recordingSession.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      if (!row) return { session: null };
    }

    const session = toSafeSession(row);
    let live: unknown;
    if (row.status === 'RECORDING') {
      try {
        live = await this.deps.recordingStatus();
      } catch {
        // fail-safe: omit live probe
      }
    }
    return live !== undefined ? { session, live } : { session };
  }

  async stop(
    userId: string,
    sessionId: string,
  ): Promise<{ sessionId: string; artifactId: string | null; status: string }> {
    assertWriteEnabled('recording');
    const row = await prisma.recordingSession.findUnique({ where: { id: sessionId } });
    if (!row) throw errors.notFound('錄製工作階段不存在');
    if (row.userId !== userId) {
      throw errors.forbidden('無權操作此錄製工作階段');
    }

    // Idempotent: already terminal / past stop — do not call MCP again.
    if (row.status !== 'RECORDING') {
      return {
        sessionId: row.id,
        artifactId: row.artifactId,
        status: row.status,
      };
    }

    const result = await this.deps.stopRecording();
    const artifactId = ulid();
    const updated = await prisma.recordingSession.update({
      where: { id: sessionId },
      data: {
        status: 'STOPPED',
        artifactId,
        metadataPath: result.metadataPath ?? null,
        eventsPath: result.eventsPath ?? null,
        stoppedAt: new Date(),
      },
    });

    if (this.activeSessionId === sessionId) this.activeSessionId = null;
    publishProgress(userId, {
      sessionId,
      status: 'STOPPED',
      artifactId,
    });

    return {
      sessionId: updated.id,
      artifactId: updated.artifactId,
      status: updated.status,
    };
  }

  async compileToDraft(
    userId: string,
    sessionId: string,
    agentId: string,
    hint?: string,
  ): Promise<{ skillId: string; reviewStatus: string; sessionId: string }> {
    assertWriteEnabled('recording');
    const row = await prisma.recordingSession.findUnique({ where: { id: sessionId } });
    if (!row) throw errors.notFound('錄製工作階段不存在');
    if (row.userId !== userId) {
      throw errors.forbidden('無權操作此錄製工作階段');
    }
    if (!row.agentId) {
      throw errors.badRequest('這是舊版錄製工作階段，請重新錄製以綁定 Agent');
    }
    if (row.agentId !== agentId) {
      throw errors.conflict('此錄製屬於另一位 Agent，無法匯入目前 Agent');
    }

    // Idempotent: already compiled.
    if (row.skillId) {
      const skill = await prisma.skill.findUnique({ where: { id: row.skillId } });
      return {
        skillId: row.skillId,
        reviewStatus: skill?.reviewStatus ?? 'AWAITING_USER_CONFIRM',
        sessionId: row.id,
      };
    }

    if (row.status !== 'STOPPED' && row.status !== 'RECORDED') {
      throw errors.badRequest('請先結束錄製');
    }

    await prisma.recordingSession.update({
      where: { id: sessionId },
      data: { status: 'COMPILING' },
    });
    publishProgress(userId, { sessionId, status: 'COMPILING' });

    try {
      const result = await this.deps.buildSkillFromRecording({
        agentId,
        createdBy: userId,
        hint,
        metadataPath: row.metadataPath ?? undefined,
        eventsPath: row.eventsPath ?? undefined,
      });

      await prisma.recordingSession.update({
        where: { id: sessionId },
        data: {
          status: 'RECORDED',
          skillId: result.skillId,
          compiledAt: new Date(),
        },
      });
      publishProgress(userId, {
        sessionId,
        status: 'RECORDED',
        skillId: result.skillId,
      });

      return {
        skillId: result.skillId,
        reviewStatus: result.reviewStatus,
        sessionId: row.id,
      };
    } catch (e) {
      await prisma.recordingSession.update({
        where: { id: sessionId },
        data: {
          status: 'FAILED',
          note: e instanceof Error ? e.message : String(e),
        },
      });
      throw e;
    }
  }

  /** Caller's RECORDING session, or the in-memory active one if it belongs to them. */
  async currentActiveSessionFor(userId: string): Promise<SafeRecordingSession | null> {
    if (this.activeSessionId) {
      const active = await prisma.recordingSession.findUnique({
        where: { id: this.activeSessionId },
      });
      if (active && active.userId === userId && active.status === 'RECORDING') {
        return toSafeSession(active);
      }
    }
    const row = await prisma.recordingSession.findFirst({
      where: { userId, status: 'RECORDING' },
      orderBy: { createdAt: 'desc' },
    });
    return row ? toSafeSession(row) : null;
  }

  /** Caller's most recent STOPPED or RECORDED session (for to-skill resolution). */
  async latestStoppedSessionFor(userId: string): Promise<SafeRecordingSession | null> {
    const row = await prisma.recordingSession.findFirst({
      where: { userId, status: { in: ['STOPPED', 'RECORDED'] } },
      orderBy: { createdAt: 'desc' },
    });
    return row ? toSafeSession(row) : null;
  }
}

export const recordingService = new RecordingService();
// Fire-and-forget recovery on module load — never block import.
void recordingService.recoverInterrupted().catch(() => {});
