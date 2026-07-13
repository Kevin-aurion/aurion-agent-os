// Seed built-in skills from builtin-skills/<slug>/SKILL.md into the DB.
// Built-ins are ours, so they are seeded as CONFIRMED (still shown with an
// understanding card in the UI). Idempotent by slug.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import { paths } from '../config.js';

function frontmatter(md: string): { data: Record<string, any>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: md };
  try {
    return { data: (parseYaml(m[1]!) as Record<string, any>) ?? {}, body: m[2] ?? '' };
  } catch {
    return { data: {}, body: m[2] ?? '' };
  }
}

async function main() {
  const dir = paths.builtinSkills;
  if (!fs.existsSync(dir)) {
    console.log('no builtin-skills dir, nothing to seed');
    return;
  }
  const slugs = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
  for (const slug of slugs) {
    const file = path.join(dir, slug, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const md = fs.readFileSync(file, 'utf8');
    const { data } = frontmatter(md);
    const kindMap: Record<string, 'PROMPT_MANUAL' | 'TOOL_MODULE' | 'COMPUTER_CONTROL'> = {
      prompt_manual: 'PROMPT_MANUAL',
      tool_module: 'TOOL_MODULE',
      computer_control: 'COMPUTER_CONTROL',
    };
    const kind = kindMap[String(data.kind ?? 'prompt_manual')] ?? 'PROMPT_MANUAL';
    await prisma.skill.upsert({
      where: { slug },
      update: { contentMd: md, kind, name: data.name ?? slug },
      create: {
        id: ulid(),
        slug,
        name: data.name ?? slug,
        origin: 'BUILTIN',
        kind,
        contentMd: md,
        understanding: {
          summary: data.description ?? '',
          capabilities: [],
          data_read: data.declares?.reads ?? [],
          data_written: data.declares?.writes ?? [],
          external_calls: [],
          irreversible_actions: data.declares?.side_effects ?? [],
          risks: [],
        },
        reviewStatus: 'CONFIRMED',
      },
    });
    console.log(`seeded builtin skill: ${slug}`);
  }
  console.log('done');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
