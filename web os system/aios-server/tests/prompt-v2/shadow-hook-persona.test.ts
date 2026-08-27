/**
 * Builder Prompt v2 call-site migration (V2-3): shadow, hook, persona sync.
 *
 * Run from `web os system/`:
 *   npx tsx aios-server/tests/prompt-v2/shadow-hook-persona.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { prisma, disconnectDb } from '../../src/lib/db.ts';
import { ensureBuilderAdvisor } from '../../src/lib/agentbuilder.ts';
import { renderShadowPrompt } from '../../src/lib/builderconversation.ts';
import { hookContext } from '../../src/lib/externalagentbuilder.ts';
import {
  assemblePrompt,
  resetPromptAssemblyCache,
  setPromptAssemblyRootsForTest,
  syncAdvisorPersonaFromRolePrompt,
} from '../../src/lib/promptassembly.ts';
import type { HarnessSnapshot } from '../../src/lib/agentbuilderevolution.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '../..');
const REAL_BUILTIN = path.join(SERVER_ROOT, 'builtin-prompts', 'builder');
const CONVERSATION_SRC = path.join(SERVER_ROOT, 'src/lib/builderconversation.ts');
const EXTERNAL_SRC = path.join(SERVER_ROOT, 'src/lib/externalagentbuilder.ts');
const AGENTBUILDER_SRC = path.join(SERVER_ROOT, 'src/lib/agentbuilder.ts');
const AGENTS_ROUTE_SRC = path.join(SERVER_ROOT, 'src/routes/agents.ts');
const STAGE_HOOK = path.join(REAL_BUILTIN, 'stage-hook.section.md');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-prompt-v2-shadow-'));
const TEST_PREFIX = 'v23-shp-';
const LESSON_HOOK_BODY = 'LESSON_HOOK_V23_MARKER：先問目的再問權限。';
const SECRET_KEY = 'sk-abcdefghijklmnopqrstuvwxyz1234';
const ADVISOR_SLUG = 'aios-agent-builder-advisor';

const HARNESS: Pick<HarnessSnapshot, 'identity' | 'skills' | 'memory' | 'policies'> = {
  identity: {
    name: '報價助理',
    purpose: '依客戶需求開立報價單',
    workingStyle: ['一次確認一項數字', '先講理解再動手'],
  },
  skills: [
    {
      name: '開立報價單',
      purpose: '依客戶需求產出報價',
      instructions: ['讀取客戶名稱與品項', '套用稅額規則'],
      inputs: ['客戶名稱', '品項'],
      outputs: ['報價單'],
      edgeCases: ['缺單價時先問'],
      status: 'DRAFT',
    },
  ],
  memory: {
    facts: ['客戶用 Excel 對帳'],
    preferences: ['回覆用繁體中文'],
    glossary: ['報價單 = quotation'],
  },
  policies: {
    allowed: ['讀取已上傳檔案'],
    requiresApproval: ['寄信'],
    forbidden: ['shell'],
  },
};

const SHADOW_EXTRA_NAMES = [
  'shadow-identity',
  'shadow-skills',
  'shadow-memory',
  'shadow-policies',
] as const;

const HOOK_RULES = [
  '請像資深顧問一樣自然理解需求、一次追問一個最有價值的問題；不要使用固定問卷，也不要要求使用者提醒你保存。',
  '對話會由 Hook 自動同步並由 AIOS 在背景建立 Agent／Skill 草稿。草稿不代表已啟用；送審、測試與正式生效仍遵守 FDE 閘門。',
  '如果使用者提供檔案，請使用 build-aios-agent Skill 的檔案同步流程；如果使用者明確要求送審，再使用該 Skill 的送審工具。',
] as const;

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    });
}

function readUtf8(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function dataDir(name: string): string {
  return path.join(tmpRoot, name);
}

function useRoots(name: string): string {
  const dir = dataDir(name);
  setPromptAssemblyRootsForTest({ dataDir: dir, builtinDir: REAL_BUILTIN });
  return dir;
}

function writeLesson(dir: string, stagesYaml: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'lesson-hook.section.md'),
    [
      '---',
      'name: lesson-hook',
      'order: 200',
      'enabled: true',
      stagesYaml,
      'origin: lesson',
      'createdAt: "2026-08-27"',
      '---',
      LESSON_HOOK_BODY,
      '',
    ].join('\n'),
    'utf8',
  );
  resetPromptAssemblyCache();
}

function writePersona(dir: string, body: string, createdAt = '2026-01-01'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'advisor-persona.section.md'),
    [
      '---',
      'name: advisor-persona',
      'order: 0',
      'enabled: true',
      'origin: builtin',
      `createdAt: "${createdAt}"`,
      '---',
      body,
      '',
    ].join('\n'),
    'utf8',
  );
  resetPromptAssemblyCache();
}

useRoots('_default');

await test('source: shadow assemblePrompt is the only origin; raw harness JSON dumps are gone', () => {
  const src = readUtf8(CONVERSATION_SRC);
  assert.match(src, /assemblePrompt\(\s*\{[\s\S]*stage:\s*'shadow'/);
  assert.equal(src.includes('JSON.stringify(harness.skills)'), false);
  assert.equal(src.includes('JSON.stringify(harness.memory)'), false);
  assert.equal(src.includes('JSON.stringify(harness.identity)'), false);
  assert.equal(src.includes('JSON.stringify(harness.policies)'), false);
  assert.match(src, /## End User 本輪輸入|userTurn|contextMessage/);
});

await test('source: hookContext is assembled from stage-hook.section.md with {{sessionId}}/{{status}}', () => {
  const src = readUtf8(EXTERNAL_SRC);
  const section = readUtf8(STAGE_HOOK);
  assert.match(src, /assemblePrompt\(\s*\{[\s\S]*stage:\s*'hook'/);
  assert.match(section, /\{\{sessionId\}\}/);
  assert.match(section, /\{\{status\}\}/);
  for (const rule of HOOK_RULES) {
    assert.equal(section.includes(rule), true, `stage-hook missing: ${rule.slice(0, 40)}`);
    assert.equal(src.includes(rule), false, `externalagentbuilder.ts still embeds: ${rule.slice(0, 40)}`);
  }
});

await test('source: advisor rolePrompt sync lives in ensureBuilderAdvisor; PATCH still blocks systemManaged', () => {
  const builder = readUtf8(AGENTBUILDER_SRC);
  const routes = readUtf8(AGENTS_ROUTE_SRC);
  assert.match(builder, /syncAdvisorPersonaFromRolePrompt/);
  assert.match(builder, /ensureBuilderAdvisor/);
  assert.match(routes, /systemManaged/);
  assert.match(routes, /系統管理 Agent 不可由一般編輯端修改/);
});

await test('(a) shadow prompt contains four extraSections and human-readable skills, not raw JSON', () => {
  useRoots('shadow');
  const userMessage = 'END_USER_TURN_MARKER 請幫我開一張報價單';
  const result = renderShadowPrompt(HARNESS as HarnessSnapshot, userMessage);
  for (const name of SHADOW_EXTRA_NAMES) {
    assert.equal(result.sectionsUsed.includes(name), true, `missing extra section ${name}`);
  }
  const system = result.systemPrompt;
  assert.match(system, /報價助理/);
  assert.match(system, /依客戶需求開立報價單/);
  assert.match(system, /開立報價單/);
  assert.match(system, /依客戶需求產出報價/);
  assert.match(system, /讀取客戶名稱與品項/);
  assert.match(system, /客戶用 Excel 對帳/);
  assert.match(system, /回覆用繁體中文/);
  assert.match(system, /寄信/);
  assert.equal(system.includes('{"name"'), false, `skills/identity still dumped as JSON: ${system.slice(0, 400)}`);
  assert.equal(system.includes('END_USER_TURN_MARKER'), false, 'End User input leaked into system prompt');
  assert.equal(result.userTurn, userMessage);
  assert.match(system, /你現在扮演以下仍在訓練中的 Shadow AI 員工/);
});

await test('(b) hook stage renders sessionId and injects a lesson whose stages include hook', () => {
  const dir = useRoots('hook');
  writeLesson(
    dir,
    ['stages:', '  - hook', '  - interview'].join('\n'),
  );
  const sessionId = `${TEST_PREFIX}sess-${ulid()}`;
  const rendered = hookContext(sessionId, 'DISCOVERY');
  assert.match(rendered, new RegExp(sessionId));
  assert.match(rendered, /DISCOVERY/);
  assert.match(rendered, new RegExp(LESSON_HOOK_BODY));
  for (const rule of HOOK_RULES) {
    assert.equal(rendered.includes(rule), true, `assembled hook missing: ${rule.slice(0, 40)}`);
  }
  const assembled = assemblePrompt({
    stage: 'hook',
    vars: { sessionId, status: 'DISCOVERY' },
  });
  assert.equal(assembled.sectionsUsed.includes('stage-hook'), true);
  assert.equal(assembled.sectionsUsed.includes('lesson-hook'), true);
  assert.equal(assembled.systemPrompt, rendered);
});

await test('(c) rolePrompt sync updates advisor-persona body, keeps frontmatter, redacts secrets', () => {
  const dir = useRoots('persona');
  writePersona(dir, 'OLD_PERSONA_BODY_SHOULD_GO', '2026-01-01');
  syncAdvisorPersonaFromRolePrompt(`新顧問人格。請用溫柔語氣。API key ${SECRET_KEY}`);
  const raw = readUtf8(path.join(dir, 'advisor-persona.section.md'));
  assert.match(raw, /^---\n/);
  assert.match(raw, /name: advisor-persona/);
  assert.match(raw, /order: 0/);
  assert.match(raw, /enabled: true/);
  assert.match(raw, /origin: builtin/);
  assert.match(raw, /createdAt: "2026-01-01"/);
  assert.match(raw, /\n---\n/);
  assert.match(raw, /新顧問人格。請用溫柔語氣。/);
  assert.match(raw, /\[REDACTED_API_KEY\]/);
  assert.equal(raw.includes(SECRET_KEY), false);
  assert.equal(raw.includes('OLD_PERSONA_BODY_SHOULD_GO'), false);

  const assembled = assemblePrompt({ stage: 'shadow', vars: {} });
  assert.match(assembled.systemPrompt, /新顧問人格。請用溫柔語氣。/);
  assert.equal(assembled.systemPrompt.includes(SECRET_KEY), false);
});

await test('(c2) ensureBuilderAdvisor create/update path syncs the current rolePrompt into the persona file', async () => {
  const dir = useRoots('persona-ensure');
  writePersona(dir, 'BEFORE_ENSURE', '2026-02-02');
  const existing = await prisma.agent.findUnique({ where: { slug: ADVISOR_SLUG } });
  if (!existing) {
    await ensureBuilderAdvisor();
    const raw = readUtf8(path.join(dir, 'advisor-persona.section.md'));
    assert.match(raw, /createdAt: "2026-02-02"/);
    assert.match(raw, /你像資深顧問|你只協助釐清企業 AI 員工需求/);
    return;
  }
  const original = existing.rolePrompt;
  const marker = `ENSURE_SYNC_MARKER_${ulid()}`;
  try {
    await prisma.agent.update({
      where: { id: existing.id },
      data: { rolePrompt: `${marker} 同步後語氣。key ${SECRET_KEY}` },
    });
    await ensureBuilderAdvisor();
    const raw = readUtf8(path.join(dir, 'advisor-persona.section.md'));
    assert.match(raw, /createdAt: "2026-02-02"/);
    assert.match(raw, new RegExp(marker));
    assert.match(raw, /同步後語氣/);
    assert.match(raw, /\[REDACTED_API_KEY\]/);
    assert.equal(raw.includes(SECRET_KEY), false);
  } finally {
    await prisma.agent.update({
      where: { id: existing.id },
      data: { rolePrompt: original },
    });
  }
});

resetPromptAssemblyCache();
setPromptAssemblyRootsForTest();
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  // best-effort
}

await disconnectDb();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
