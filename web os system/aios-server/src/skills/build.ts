// Reusable skill build: create row immediately, draft SKILL.md in background.
// Extracted from POST /api/skills/build so agent compose can fan out the same path.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as YAML from 'yaml';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import { paths } from '../config.js';
import { draftWithEngine, type DraftEngine } from '../engine/draft.js';
import { understandSkill } from './understand.js';
import { slugify } from '../lib/slug.js';

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

/**
 * COMPUTER_CONTROL skills can only run via the desktop app. Build always uses
 * PROMPT_MANUAL, so this only normalises an optional requested env (same as
 * the original route's resolveExecutionEnv('PROMPT_MANUAL', …)).
 */
function resolveBuildExecutionEnv(
  requested: 'CLI' | 'DESKTOP_APP' | 'DIRECT' | undefined,
): 'CLI' | 'DESKTOP_APP' | 'DIRECT' {
  return requested ?? 'CLI';
}

/**
 * Create a skill row immediately and kick off background drafting +
 * understandSkill. Returns before drafting finishes (same as the HTTP route).
 * Does not confirm or attach the skill to any agent.
 */
export async function buildSkillFromRequirement(params: {
  requirement: string;
  engine: DraftEngine;
  executionEnv?: 'CLI' | 'DESKTOP_APP' | 'DIRECT';
  assets?: Record<string, unknown>;
}): Promise<{ skillId: string; slug: string }> {
  const firstLine = (params.requirement.split(/\r?\n/)[0] ?? '').slice(0, 40).trim() || 'Generated skill';
  const executionEnv = resolveBuildExecutionEnv(params.executionEnv);
  const id = ulid();
  const slug = await uniqueSlug(slugify(firstLine));

  // Create the skill row immediately so callers return fast (drafting +
  // understanding can take ~1 min combined). reviewStatus
  // 'PENDING_UNDERSTANDING' = still drafting/analysing.
  await prisma.skill.create({
    data: {
      id,
      slug,
      name: firstLine,
      origin: 'CLI_GENERATED',
      kind: 'PROMPT_MANUAL',
      contentMd: `（${params.engine} 正在草擬技能中…）\n\n[Requirement]\n${params.requirement}`,
      generator: params.engine,
      reviewStatus: 'PENDING_UNDERSTANDING',
      executionEnv,
      assets: params.assets ? (params.assets as object) : undefined,
    },
  });

  // Draft with the chosen engine, then run understand — never blocks the caller.
  void (async () => {
    const draftPrompt = [
      'Draft a SKILL.md file for the following requirement. Include a YAML frontmatter block with at least `name` and `description` fields, followed by the skill manual body (what it does, how to use it, any caveats).',
      'Output ONLY the markdown content of SKILL.md — no commentary, no surrounding code fences.',
      '',
      `[Requirement]\n${params.requirement}`,
    ].join('\n');
    const drafted = await draftWithEngine(params.engine, draftPrompt);
    const contentMd =
      drafted && drafted.trim()
        ? drafted.trim()
        : `---\nname: ${firstLine.replace(/[:\n]/g, ' ')}\ndescription: Auto-generated stub — engine unavailable at build time.\n---\n\n# ${firstLine}\n\n${params.requirement}\n`;
    const { meta } = parseFrontmatter(contentMd);
    const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : firstLine;
    await writeSkillFile(slug, 'SKILL.md', contentMd);
    await prisma.skill.update({ where: { id }, data: { contentMd, name } }).catch(() => {});
    try {
      await understandSkill(id);
    } catch (e) {
      console.error('[skills/build] understandSkill failed', { skillId: id, err: e });
    }
  })();

  return { skillId: id, slug };
}
