// Materializes an Agent + its confirmed skills from the DB onto disk under
// paths.agents/<department>/<slug>/ — agent.md (frontmatter overview), CLAUDE.md (role
// prompt, injected as the execute engine's system prompt), and
// skills/<slug>/SKILL.md per confirmed AgentSkill. This directory is also
// where per-agent tools/ live (see tools.ts) and where the CLI engines are
// spawned with cwd = agentDir. Idempotent: unchanged files are left alone.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../lib/db.js';
import { paths } from '../config.js';
import { sha256 } from '../lib/crypto.js';
import { errors } from '../lib/http.js';
import { sanitizeSegment, assertInsideRoot } from '../lib/safepath.js';
import { ensureAgentWiki } from '../memory/memoryService.js';

async function writeIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await readFile(filePath, 'utf8');
    if (sha256(existing) === sha256(content)) return; // unchanged, skip the write
  } catch {
    // file doesn't exist yet — fall through to write it
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

function yamlList(items: string[]): string {
  return items.length ? items.map((s) => `  - ${s}`).join('\n') : '  []';
}

const DEFAULT_DEPARTMENT = '未分類';

/** Sanitizes a department name for use as a filesystem folder name. */
function sanitizeDepartment(department: string | null | undefined): string {
  // Strips separators/reserved chars; pure-dot segments ('.'/'..'/'...') → fallback.
  return sanitizeSegment((department ?? '').trim(), DEFAULT_DEPARTMENT);
}

function buildAgentMd(
  agent: { slug: string; name: string; description: string; engineExecute: string; maxRounds: number },
  skillSlugs: string[],
  workflows: { id: string; name: string; steps: { stepKey: string; type: string }[] }[],
): string {
  const engineVerify = agent.engineExecute === 'CLAUDE_CODE' ? 'CODEX' : 'CLAUDE_CODE';
  const workflowLines = workflows.length
    ? workflows
        .map((w) => `  - id: ${w.id}\n    name: ${JSON.stringify(w.name)}\n    steps: [${w.steps.map((s) => `${s.stepKey}:${s.type}`).join(', ')}]`)
        .join('\n')
    : '  []';
  return [
    '---',
    `slug: ${agent.slug}`,
    `name: ${JSON.stringify(agent.name)}`,
    'engine:',
    `  execute: ${agent.engineExecute}`,
    `  verify: ${engineVerify}`,
    `maxRounds: ${agent.maxRounds}`,
    'skills:',
    yamlList(skillSlugs),
    'workflows:',
    workflowLines,
    '---',
    '',
    `# ${agent.name}`,
    '',
    agent.description ?? '',
    '',
  ].join('\n');
}

/**
 * Reads the Agent + its confirmed AgentSkills from the DB and writes the
 * on-disk agent directory. Returns the agent directory's absolute path.
 */
export async function materializeAgent(agentId: string): Promise<string> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      skills: { include: { skill: true } },
      workflows: {
        where: { deletedAt: null },
        include: { steps: { orderBy: { position: 'asc' } } },
      },
    },
  });
  if (!agent || agent.deletedAt) throw errors.notFound(`Agent not found: ${agentId}`);

  const confirmedSkills = agent.skills
    .map((as) => as.skill)
    .filter((s) => s.reviewStatus === 'CONFIRMED' && !s.deletedAt);

  // Resolve under agents root, then assert no escape (defense in depth after sanitize).
  const agentDir = assertInsideRoot(
    paths.agents,
    path.join(paths.agents, sanitizeDepartment(agent.department), agent.slug),
  );
  await mkdir(agentDir, { recursive: true });

  const agentMd = buildAgentMd(agent, confirmedSkills.map((s) => s.slug), agent.workflows);
  await writeIfChanged(path.join(agentDir, 'agent.md'), agentMd);
  await writeIfChanged(path.join(agentDir, 'CLAUDE.md'), agent.rolePrompt ?? '');

  for (const skill of confirmedSkills) {
    await writeIfChanged(path.join(agentDir, 'skills', skill.slug, 'SKILL.md'), skill.contentMd ?? '');
  }

  // L1 memory wiki skeleton (index/facts/log/decisions). create-only — never
  // overwrites existing human/engine edits (must not use writeIfChanged).
  try {
    await ensureAgentWiki(agentDir);
  } catch (e) {
    console.warn('[materialize] ensureAgentWiki failed (non-fatal)', e instanceof Error ? e.message : e);
  }

  return agentDir;
}
