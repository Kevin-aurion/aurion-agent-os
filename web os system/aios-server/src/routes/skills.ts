import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import * as YAML from 'yaml';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { prisma } from '../lib/db.js';
import { paths } from '../config.js';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { audit } from '../lib/audit.js';
import { understandSkill } from '../skills/understand.js';

// ── Helpers: slugs & frontmatter ────────────────────────────────────────────

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'skill';
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.skill.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

function parseFrontmatter(md: string): { meta: Record<string, unknown>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  try {
    const parsed = YAML.parse(m[1] ?? '');
    const meta = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return { meta, body: m[2] ?? '' };
  } catch {
    return { meta: {}, body: md };
  }
}

async function writeSkillFile(slug: string, relPath: string, data: Buffer | string): Promise<void> {
  const dest = path.join(paths.skills, slug, relPath);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, data);
}

// ── Minimal ZIP reader (no zip library is installed) ────────────────────────
// Reads the End-Of-Central-Directory record, walks the central directory,
// and inflates each entry (store or deflate) via node:zlib. Enough to unpack
// a skill bundle's SKILL.md + assets without adding a dependency.

interface ZipEntry {
  name: string;
  data: Buffer;
}

function readZip(buf: Buffer): ZipEntry[] {
  const EOCD_SIG = 0x06054b50;
  const CDFH_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  let eocdOffset = -1;
  const minEocd = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Not a valid zip file (End Of Central Directory not found)');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < totalEntries; i++) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== CDFH_SIG) break;
    const compMethod = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (buf.readUInt32LE(localHeaderOffset) !== LFH_SIG) throw new Error(`Bad local file header for zip entry "${name}"`);
    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    if (!name.endsWith('/')) {
      let data: Buffer;
      if (compMethod === 0) data = Buffer.from(raw);
      else if (compMethod === 8) data = zlib.inflateRawSync(raw);
      else throw new Error(`Unsupported zip compression method ${compMethod} for entry "${name}"`);
      entries.push({ name, data });
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Drop a single shared top-level directory (e.g. `my-skill/SKILL.md` -> `SKILL.md`). */
function stripCommonPrefix(entries: ZipEntry[]): ZipEntry[] {
  if (!entries.length) return entries;
  const first = entries[0] as ZipEntry;
  const slash = first.name.indexOf('/');
  if (slash < 0) return entries;
  const prefix = first.name.slice(0, slash + 1);
  if (prefix && entries.every((e) => e.name.startsWith(prefix))) {
    return entries.map((e) => ({ name: e.name.slice(prefix.length), data: e.data }));
  }
  return entries;
}

function findSkillMd(entries: ZipEntry[]): ZipEntry | undefined {
  const candidates = entries.filter((e) => /(^|\/)skill\.md$/i.test(e.name));
  candidates.sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  return candidates[0];
}

// ── Route module ─────────────────────────────────────────────────────────────

const executionEnvSchema = z.enum(['CLI', 'DESKTOP_APP', 'DIRECT']);

const createSkillSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['PROMPT_MANUAL', 'TOOL_MODULE', 'COMPUTER_CONTROL']),
  contentMd: z.string().min(1),
  origin: z.enum(['UPLOADED', 'BUILTIN', 'CLI_GENERATED']).optional(),
  executionEnv: executionEnvSchema.optional(),
});

const buildSchema = z.object({
  requirement: z.string().min(1),
  engine: z.enum(['CLAUDE_CODE', 'CODEX', 'GROK']).default('CLAUDE_CODE'),
  executionEnv: executionEnvSchema.optional(),
});

const patchSkillSchema = z.object({
  name: z.string().min(1).optional(),
  executionEnv: executionEnvSchema.optional(),
});

const idParamSchema = z.object({ id: z.string().min(1) });

/**
 * COMPUTER_CONTROL skills can only run via the desktop app (record/replay
 * computer-use is not available from the CLI). Given a requested kind and
 * executionEnv, return the enforced executionEnv plus an optional note if
 * an override happened.
 */
function resolveExecutionEnv(
  kind: 'PROMPT_MANUAL' | 'TOOL_MODULE' | 'COMPUTER_CONTROL',
  requested: 'CLI' | 'DESKTOP_APP' | 'DIRECT' | undefined,
): { executionEnv: 'CLI' | 'DESKTOP_APP' | 'DIRECT'; note?: string } {
  const wanted = requested ?? 'CLI';
  if (kind === 'COMPUTER_CONTROL' && wanted !== 'DESKTOP_APP') {
    return {
      executionEnv: 'DESKTOP_APP',
      note: `executionEnv overridden to DESKTOP_APP: COMPUTER_CONTROL skills (record/replay computer-use) can only run via the desktop app, not "${wanted}".`,
    };
  }
  if (kind === 'COMPUTER_CONTROL') return { executionEnv: 'DESKTOP_APP' };
  return { executionEnv: wanted };
}

export async function skillRoutes(app: FastifyInstance) {
  app.get('/api/skills', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const skills = await prisma.skill.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } });
      return ok(skills);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/skills/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const skill = await prisma.skill.findUnique({ where: { id } });
      if (!skill || skill.deletedAt) throw errors.notFound('Skill not found');
      return ok(skill);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.patch('/api/skills/:id', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const body = patchSkillSchema.parse(req.body);
      const skill = await prisma.skill.findUnique({ where: { id } });
      if (!skill || skill.deletedAt) throw errors.notFound('Skill not found');

      const data: { name?: string; executionEnv?: 'CLI' | 'DESKTOP_APP' | 'DIRECT' } = {};
      let note: string | undefined;
      if (body.name !== undefined) data.name = body.name;
      if (body.executionEnv !== undefined) {
        const resolved = resolveExecutionEnv(skill.kind, body.executionEnv);
        data.executionEnv = resolved.executionEnv;
        note = resolved.note;
      }

      const updated = Object.keys(data).length ? await prisma.skill.update({ where: { id }, data }) : skill;
      await audit(req.user!.sub, 'skill.update', 'Skill', id, data);
      return ok(note ? { ...updated, note } : updated);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/skills', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const body = createSkillSchema.parse(req.body);
      const { meta } = parseFrontmatter(body.contentMd);
      const slug = await uniqueSlug(slugify(body.name));
      const id = ulid();
      const { executionEnv, note } = resolveExecutionEnv(body.kind, body.executionEnv);

      await writeSkillFile(slug, 'SKILL.md', body.contentMd);

      await prisma.skill.create({
        data: {
          id,
          slug,
          name: body.name,
          origin: body.origin ?? 'UPLOADED',
          kind: body.kind,
          contentMd: body.contentMd,
          assets: Object.keys(meta).length ? (meta as object) : undefined,
          reviewStatus: 'PENDING_UNDERSTANDING',
          executionEnv,
        },
      });
      await audit(req.user!.sub, 'skill.create', 'Skill', id, { slug, kind: body.kind, origin: body.origin ?? 'UPLOADED', executionEnv });

      try {
        await understandSkill(id);
      } catch (e) {
        req.log.error({ err: e, skillId: id }, 'understandSkill failed');
      }

      const fresh = await prisma.skill.findUnique({ where: { id } });
      return ok(note ? { ...fresh, note } : fresh);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/skills/upload', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const file = await req.file();
      if (!file) throw errors.badRequest('No file uploaded (expected multipart field with a .md or .zip file)');

      const filename = file.filename ?? 'upload';
      const ext = path.extname(filename).toLowerCase();
      if (ext !== '.md' && ext !== '.zip') throw errors.badRequest(`Unsupported upload type "${ext}" — expected .md or .zip`);

      const buf = await file.toBuffer();
      const fields: any = file.fields ?? {};
      const fieldName = typeof fields.name?.value === 'string' ? String(fields.name.value).trim() : '';
      const fieldKind = typeof fields.kind?.value === 'string' ? String(fields.kind.value).trim() : '';
      const fieldExecutionEnv = typeof fields.executionEnv?.value === 'string' ? String(fields.executionEnv.value).trim() : '';

      let contentMd: string;
      let assetNames: string[] = [];
      const baseName = fieldName || path.basename(filename, ext);
      let kind: 'PROMPT_MANUAL' | 'TOOL_MODULE' | 'COMPUTER_CONTROL' = 'PROMPT_MANUAL';
      if (fieldKind === 'TOOL_MODULE' || fieldKind === 'COMPUTER_CONTROL' || fieldKind === 'PROMPT_MANUAL') kind = fieldKind;
      let requestedExecutionEnv: 'CLI' | 'DESKTOP_APP' | 'DIRECT' | undefined;
      if (fieldExecutionEnv === 'CLI' || fieldExecutionEnv === 'DESKTOP_APP' || fieldExecutionEnv === 'DIRECT') {
        requestedExecutionEnv = fieldExecutionEnv;
      }

      const slugPreview = slugify(baseName);
      const slug = await uniqueSlug(slugPreview);

      if (ext === '.md') {
        contentMd = buf.toString('utf8');
        await writeSkillFile(slug, 'SKILL.md', contentMd);
      } else {
        const rawEntries = readZip(buf);
        const entries = stripCommonPrefix(rawEntries);
        const skillMd = findSkillMd(entries);
        if (!skillMd) throw errors.badRequest('Uploaded zip does not contain a SKILL.md file');
        contentMd = skillMd.data.toString('utf8');
        if (!fieldKind) kind = 'TOOL_MODULE'; // zips typically bundle tool code/assets alongside the manual
        for (const entry of entries) {
          await writeSkillFile(slug, entry.name, entry.data);
        }
        assetNames = entries.map((e) => e.name);
      }

      const { meta } = parseFrontmatter(contentMd);
      const name = fieldName || (typeof meta.name === 'string' ? meta.name : baseName);
      const id = ulid();
      const { executionEnv, note } = resolveExecutionEnv(kind, requestedExecutionEnv);

      await prisma.skill.create({
        data: {
          id,
          slug,
          name,
          origin: 'UPLOADED',
          kind,
          contentMd,
          assets: assetNames.length ? ({ files: assetNames } as object) : undefined,
          reviewStatus: 'PENDING_UNDERSTANDING',
          executionEnv,
        },
      });
      await audit(req.user!.sub, 'skill.upload', 'Skill', id, { slug, kind, filename, executionEnv });

      try {
        await understandSkill(id);
      } catch (e) {
        req.log.error({ err: e, skillId: id }, 'understandSkill failed');
      }

      const fresh = await prisma.skill.findUnique({ where: { id } });
      return ok(note ? { ...fresh, note } : fresh);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/skills/:id/confirm', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const skill = await prisma.skill.findUnique({ where: { id } });
      if (!skill || skill.deletedAt) throw errors.notFound('Skill not found');
      const updated = await prisma.skill.update({
        where: { id },
        data: { reviewStatus: 'CONFIRMED', confirmedBy: req.user!.sub, confirmedAt: new Date() },
      });
      await audit(req.user!.sub, 'skill.confirm', 'Skill', id);
      return ok(updated);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/skills/:id/reject', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const skill = await prisma.skill.findUnique({ where: { id } });
      if (!skill || skill.deletedAt) throw errors.notFound('Skill not found');
      const updated = await prisma.skill.update({ where: { id }, data: { reviewStatus: 'REJECTED' } });
      await audit(req.user!.sub, 'skill.reject', 'Skill', id);
      return ok(updated);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/skills/build', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const body = buildSchema.parse(req.body);
      const firstLine = (body.requirement.split(/\r?\n/)[0] ?? '').slice(0, 40).trim() || 'Generated skill';
      const { executionEnv } = resolveExecutionEnv('PROMPT_MANUAL', body.executionEnv);
      const id = ulid();
      const slug = await uniqueSlug(slugify(firstLine));

      // Create the skill row immediately so the POST returns fast (drafting +
      // understanding can take ~1 min combined — far longer than the dev proxy
      // timeout). The trainer UI polls GET /api/skills/:id until the review
      // status advances. status 'PENDING_UNDERSTANDING' = still drafting/analysing.
      await prisma.skill.create({
        data: {
          id,
          slug,
          name: firstLine,
          origin: 'CLI_GENERATED',
          kind: 'PROMPT_MANUAL',
          contentMd: `（${body.engine} 正在草擬技能中…）\n\n[Requirement]\n${body.requirement}`,
          generator: body.engine,
          reviewStatus: 'PENDING_UNDERSTANDING',
          executionEnv,
        },
      });
      await audit(req.user!.sub, 'skill.build', 'Skill', id, { engine: body.engine, executionEnv });

      // Draft with the chosen engine, then run the understand→confirm pipeline —
      // all in the background; never blocks the HTTP response.
      void (async () => {
        const draftPrompt = [
          'Draft a SKILL.md file for the following requirement. Include a YAML frontmatter block with at least `name` and `description` fields, followed by the skill manual body (what it does, how to use it, any caveats).',
          'Output ONLY the markdown content of SKILL.md — no commentary, no surrounding code fences.',
          '',
          `[Requirement]\n${body.requirement}`,
        ].join('\n');
        let drafted: string | null = null;
        try {
          if (body.engine === 'CODEX') {
            const mod: any = await import('../engine/codex.js');
            drafted = (await mod.runCodex({ prompt: draftPrompt, cwd: paths.cache, sandbox: 'read-only', timeoutMs: 5 * 60_000 }))?.text ?? null;
          } else if (body.engine === 'GROK') {
            const mod: any = await import('../engine/grok.js');
            drafted = (await mod.runGrok({ prompt: draftPrompt, cwd: paths.cache, timeoutMs: 5 * 60_000 }))?.stdout ?? null;
          } else {
            const mod: any = await import('../engine/claude.js');
            drafted = (await mod.runClaude({ prompt: draftPrompt, cwd: paths.cache, timeoutMs: 5 * 60_000 }))?.stdout ?? null;
          }
        } catch {
          drafted = null;
        }
        const contentMd =
          drafted && drafted.trim()
            ? drafted.trim()
            : `---\nname: ${firstLine.replace(/[:\n]/g, ' ')}\ndescription: Auto-generated stub — engine unavailable at build time.\n---\n\n# ${firstLine}\n\n${body.requirement}\n`;
        const { meta } = parseFrontmatter(contentMd);
        const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : firstLine;
        await writeSkillFile(slug, 'SKILL.md', contentMd);
        await prisma.skill.update({ where: { id }, data: { contentMd, name } }).catch(() => {});
        try {
          await understandSkill(id);
        } catch (e) {
          req.log.error({ err: e, skillId: id }, 'understandSkill failed');
        }
      })();

      const fresh = await prisma.skill.findUnique({ where: { id } });
      return ok(fresh);
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
