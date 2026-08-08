// Oral / conversational skill training helpers.
// Deterministic flow listing + Claude-drafted SKILL.md that always goes through
// understandSkill → AWAITING_USER_CONFIRM (never auto-CONFIRMED).
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { ulid } from 'ulid';
import { prisma } from './db.js';
import { paths } from '../config.js';
import { errors } from './http.js';
import { runClaude } from '../engine/claude.js';
import { materializeAgent } from '../engine/materialize.js';
import { understandSkill } from '../skills/understand.js';
import { slugify } from './slug.js';

const DRAFT_REVIEW_STATUSES = new Set(['PENDING_UNDERSTANDING', 'AWAITING_USER_CONFIRM']);
const DRAFT_TIMEOUT_MS = 5 * 60_000;
const TRAINING_DEDUPE_TTL_MS = 10 * 60_000;

type DraftSkillResult = {
  skillId: string;
  contentMd: string;
  reviewStatus: string;
  understanding: unknown;
};

// A proxy/tunnel may lose the HTTP response after the model-backed mutation
// already succeeded. Share identical in-flight work and briefly cache the
// result so a safe client retry cannot create a duplicate Skill.
const trainingDraftsInFlight = new Map<string, Promise<DraftSkillResult>>();
const recentTrainingDrafts = new Map<
  string,
  { expiresAt: number; result: DraftSkillResult }
>();

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

function stripCodeFences(s: string): string {
  const t = s.trim();
  const fenced = t.match(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/i);
  return fenced ? (fenced[1] ?? t).trim() : t;
}

function understandingSummary(understanding: unknown): string {
  if (understanding && typeof understanding === 'object' && !Array.isArray(understanding)) {
    const s = (understanding as Record<string, unknown>).summary;
    if (typeof s === 'string') return s;
  }
  return '';
}

function triggerType(trigger: unknown): string {
  if (trigger && typeof trigger === 'object' && !Array.isArray(trigger)) {
    const t = (trigger as Record<string, unknown>).type;
    if (typeof t === 'string' && t.trim()) return t;
  }
  return 'unknown';
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

/**
 * Deterministic inventory of an agent's mounted skills + workflows.
 * No LLM — plain DB read with understanding.summary as the skill blurb.
 */
export async function listAgentFlows(agentId: string): Promise<{
  skills: Array<{ id: string; name: string; summary: string; reviewStatus: string }>;
  workflows: Array<{ id: string; name: string; trigger: string }>;
}> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    include: {
      skills: { include: { skill: true } },
      workflows: {
        where: { deletedAt: null },
        select: { id: true, name: true, trigger: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!agent) throw errors.notFound('Agent not found');

  const skills = agent.skills
    .map((as) => as.skill)
    .filter((s) => !s.deletedAt)
    .map((s) => ({
      id: s.id,
      name: s.name,
      summary: understandingSummary(s.understanding),
      reviewStatus: s.reviewStatus,
    }));

  const workflows = agent.workflows.map((w) => ({
    id: w.id,
    name: w.name,
    trigger: triggerType(w.trigger),
  }));

  return { skills, workflows };
}

/**
 * Draft (or update a draft) SKILL.md from a natural-language message via Claude,
 * persist the skill, run understandSkill, and return the awaiting-confirm draft.
 * Never sets reviewStatus to CONFIRMED — only the existing confirm endpoint does that.
 */
export async function draftSkillFromMessage(args: {
  agentId: string;
  message: string;
  skillId?: string;
  createdBy: string;
}): Promise<DraftSkillResult> {
  const message = args.message.trim();
  if (!message) throw errors.badRequest('message is required');

  const requestKey = createHash('sha256')
    .update(`${args.agentId}\0${args.createdBy}\0${args.skillId ?? ''}\0${message}`)
    .digest('hex');
  const cached = recentTrainingDrafts.get(requestKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (cached) recentTrainingDrafts.delete(requestKey);
  const existingWork = trainingDraftsInFlight.get(requestKey);
  if (existingWork) return existingWork;

  const work = (async (): Promise<DraftSkillResult> => {

  const agent = await prisma.agent.findFirst({ where: { id: args.agentId, deletedAt: null } });
  if (!agent) throw errors.notFound('Agent not found');

  // Validate an edit target before materializing or spending any model tokens.
  // An arbitrary/foreign skillId must fail without exposing agent context to the
  // drafting engine or creating filesystem side effects.
  let existingDraft: { id: string; slug: string } | undefined;
  if (args.skillId) {
    const existing = await prisma.skill.findFirst({
      where: { id: args.skillId, deletedAt: null },
      select: { id: true, slug: true, reviewStatus: true },
    });
    if (!existing) throw errors.notFound('Skill draft not found');
    if (!DRAFT_REVIEW_STATUSES.has(existing.reviewStatus)) {
      throw errors.conflict(
        `Skill is not an editable draft (status=${existing.reviewStatus})`,
      );
    }
    const link = await prisma.agentSkill.findUnique({
      where: { agentId_skillId: { agentId: args.agentId, skillId: existing.id } },
    });
    if (!link) throw errors.forbidden('Skill draft is not scoped to this agent');
    existingDraft = existing;
  }

  // Materialize agent dir for Claude cwd (role context + workspace).
  const agentDir = await materializeAgent(args.agentId);

  const draftPrompt = [
    'Draft a SKILL.md file for the following operator description.',
    'Include a YAML frontmatter block with at least `name` and `description` fields,',
    'followed by clear Markdown steps the agent should follow (what it does, how to use it, caveats).',
    'Output ONLY the markdown content of SKILL.md — no commentary, no surrounding code fences.',
    '',
    `[Operator description]\n${message}`,
  ].join('\n');

  let contentMd: string;
  try {
    const drafted = await runClaude({
      prompt: draftPrompt,
      cwd: agentDir,
      timeoutMs: DRAFT_TIMEOUT_MS,
    });
    contentMd = stripCodeFences(drafted.stdout);
  } catch (e) {
    // Fallback stub so the understand → confirm gate still runs when Claude is offline.
    // Still never CONFIRMED.
    const firstLine = (message.split(/\r?\n/)[0] ?? '').slice(0, 40).trim() || '口述訓練技能';
    const safeName = firstLine.replace(/[:\n]/g, ' ');
    contentMd = [
      '---',
      `name: ${safeName}`,
      'description: Auto-generated stub — Claude unavailable at draft time; human review required.',
      '---',
      '',
      `# ${safeName}`,
      '',
      message,
      '',
      `> Draft engine error: ${e instanceof Error ? e.message : String(e)}`,
      '',
    ].join('\n');
  }

  if (!contentMd.trim()) throw errors.internal('Claude returned empty SKILL.md');

  const { meta } = parseFrontmatter(contentMd);
  const firstLine = (message.split(/\r?\n/)[0] ?? '').slice(0, 40).trim() || '口述訓練技能';
  const name =
    typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : firstLine;

  // Prefer updating an existing draft when skillId is provided — fail-closed:
  // skill must exist, still be a draft, and already be linked to *this* agent.
  // Arbitrary skillId must not edit another agent's (or unlinked) draft.
  let skillId: string | undefined;
  if (existingDraft) {
    skillId = existingDraft.id;
    await writeSkillFile(existingDraft.slug, contentMd);
    await prisma.skill.update({
      where: { id: existingDraft.id },
      data: {
        contentMd,
        name,
        // Reset so understand pipeline re-runs cleanly.
        reviewStatus: 'PENDING_UNDERSTANDING',
        understanding: Prisma.DbNull,
        generator: 'oral-training',
      },
    });
  }

  if (!skillId) {
    const id = ulid();
    const slug = await uniqueSlug(slugify(name));
    await writeSkillFile(slug, contentMd);
    await prisma.skill.create({
      data: {
        id,
        slug,
        name,
        origin: 'CLI_GENERATED',
        kind: 'PROMPT_MANUAL',
        contentMd,
        generator: 'oral-training',
        reviewStatus: 'PENDING_UNDERSTANDING',
        executionEnv: 'CLI',
      },
    });
    skillId = id;
  }

  // Agent-scoped training: link draft so listAgentFlows can surface it.
  // (Normal mount endpoint only accepts CONFIRMED skills.)
  await ensureAgentSkillLink(args.agentId, skillId);

  // Cross-model understand gate — sets AWAITING_USER_CONFIRM. Never CONFIRMED here.
  const understanding = await understandSkill(skillId);
  if (!understanding) throw errors.notFound('Skill disappeared during understand');

  const skill = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!skill || skill.deletedAt) throw errors.notFound('Skill not found after understand');

  // Hard guard: this path must never auto-confirm.
  if (skill.reviewStatus === 'CONFIRMED') {
    throw errors.internal('oral training must not auto-confirm skills');
  }

  // createdBy is accepted for audit/call-site; Skill has no createdBy column.
  void args.createdBy;

  return {
    skillId: skill.id,
    contentMd: skill.contentMd,
    reviewStatus: skill.reviewStatus,
    understanding: skill.understanding,
  };
  })();

  trainingDraftsInFlight.set(requestKey, work);
  try {
    const result = await work;
    recentTrainingDrafts.set(requestKey, {
      expiresAt: Date.now() + TRAINING_DEDUPE_TTL_MS,
      result,
    });
    return result;
  } finally {
    trainingDraftsInFlight.delete(requestKey);
  }
}
