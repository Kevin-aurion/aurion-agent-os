/**
 * Builder Prompt v2 lesson loop (V2-4).
 *
 * Run from `web os system/`:
 *   npx tsx aios-server/tests/prompt-v2/lesson-loop.test.ts
 *
 * {{ rejection (e): ingest-time. Candidates whose lessonText contains `{{`
 * are dropped before createProposal. approveProposal also fail-closes
 * before writing a file, but this suite asserts the ingest gate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { prisma, disconnectDb } from '../../src/lib/db.ts';
import { abandonBuilderSession } from '../../src/lib/agentbuilder.ts';
import { approveProposal, rejectProposal } from '../../src/lib/changeproposal.ts';
import {
  BUILDER_LESSON_ACTION,
  BUILDER_LESSON_CAP,
  BUILDER_LESSON_MERGE_ACTION,
  enqueueBuilderSelfReflection,
  lessonFileNameFor,
  setBuilderLessonRunAgentForTest,
} from '../../src/lib/builderlessons.ts';
import {
  assemblePrompt,
  resetPromptAssemblyCache,
  setPromptAssemblyRootsForTest,
} from '../../src/lib/promptassembly.ts';
import type { RunAgentOptions, RunOutcome } from '../../src/engine/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '../..');
const REAL_BUILTIN = path.join(SERVER_ROOT, 'builtin-prompts', 'builder');
const AGENTBUILDER_SRC = path.join(SERVER_ROOT, 'src/lib/agentbuilder.ts');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-prompt-v2-lesson-'));
const TEST_PREFIX = 'v24-lesson-';
const SECRET_KEY = 'sk-abcdefghijklmnopqrstuvwxyz1234';
const DECIDED_BY = 'v24-lesson-fde';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function dataDir(name: string): string {
  return path.join(tmpRoot, name);
}

function useRoots(name: string): string {
  const dir = dataDir(name);
  setPromptAssemblyRootsForTest({ dataDir: dir, builtinDir: REAL_BUILTIN });
  return dir;
}

function mockOutcome(payload: unknown): RunOutcome {
  return {
    ok: true,
    runId: ulid(),
    runDir: '/tmp/aios-lesson-loop',
    status: 'SUCCEEDED',
    results: [{
      ok: true,
      stepKey: 'do',
      type: 'DO',
      output: JSON.stringify(payload),
      rounds: 1,
      approved: true,
      records: [],
    }],
    reworkHistory: [],
  };
}

function mockRunAgent(payload: unknown): (opts: RunAgentOptions) => Promise<RunOutcome> {
  return async () => mockOutcome(payload);
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    title: '先問目的再要檔案',
    lessonText: '不要在第一輪就要求上傳檔案；先問清楚目的與成功標準。同一欄位連續 2 輪沒有新資訊才可跳過。',
    evidence: [1, 3],
    stages: ['interview'],
    dedupeKey: `ask-purpose-${ulid()}`,
    ...overrides,
  };
}

async function seedSession(opts?: {
  status?: 'DISCOVERY' | 'ACTIVE' | 'ABANDONED';
  transcript?: unknown;
}): Promise<{ sessionId: string; userId: string }> {
  const userId = `${TEST_PREFIX}${ulid()}`;
  const sessionId = `${TEST_PREFIX}sess-${ulid()}`;
  await prisma.agentBuildSession.create({
    data: {
      id: sessionId,
      userId,
      status: opts?.status ?? 'DISCOVERY',
      brief: { objective: '報價單員工' },
      transcript: (opts?.transcript ?? [
        { role: 'user', content: '我想做一個報價單員工', at: new Date().toISOString() },
        { role: 'assistant', content: '最近一次開報價單時卡在哪一步？', at: new Date().toISOString() },
        { role: 'user', content: '每次都要重填客戶資料，而且常常漏稅額', at: new Date().toISOString() },
      ]) as object,
      testResult: { ok: true, status: 'PASSED', summary: '一次通過' },
    },
  });
  return { sessionId, userId };
}

async function proposalsForSession(sessionId: string) {
  const rows = await prisma.changeProposal.findMany({
    where: { proposedBy: 'system', source: 'REFLECTION' },
    orderBy: { createdAt: 'asc' },
  });
  return rows.filter((row) => asRecord(row.proposedChange)?.sessionId === sessionId);
}

async function cleanupSession(sessionId: string): Promise<void> {
  const related = await proposalsForSession(sessionId);
  const merge = await prisma.changeProposal.findMany({
    where: { proposedBy: 'system', source: 'REFLECTION' },
  });
  const extra = merge.filter((row) => {
    const rec = asRecord(row.proposedChange);
    return rec?.action === BUILDER_LESSON_MERGE_ACTION && rec.sessionId === sessionId;
  });
  const ids = [...new Set([...related, ...extra].map((row) => row.id))];
  if (ids.length) await prisma.changeProposal.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.agentBuildSession.deleteMany({ where: { id: sessionId } }).catch(() => {});
}

function writeDummyLesson(dir: string, index: number): void {
  fs.mkdirSync(dir, { recursive: true });
  const name = `lesson-cap-filler-${String(index).padStart(2, '0')}`;
  const body = [
    '---',
    `name: ${name}`,
    `order: ${200 + index}`,
    'enabled: true',
    'origin: lesson',
    'stages: [interview]',
    'createdAt: "2026-08-27"',
    `dedupeKey: cap-filler-${index}`,
    '---',
    `不要在第 ${index + 1} 輪重複詢問已確認的目的；改問下一個未解卡點。`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${name}.section.md`), body, 'utf8');
}

const originalQueue = process.env.AIOS_BUILDER_EVOLUTION_QUEUE;
process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
useRoots('_default');

await test('source: direct activation and abandonBuilderSession enqueue self-reflection', () => {
  const src = fs.readFileSync(AGENTBUILDER_SRC, 'utf8');
  assert.match(src, /async function enqueueBuilderSelfReflectionSafe/);
  assert.match(src, /await enqueueBuilderSelfReflectionSafe\(row\.id\)/);
  const abandonIdx = src.indexOf('export async function abandonBuilderSession');
  const activateIdx = src.indexOf('async function activateBuilderArtifacts');
  const abandonCall = src.indexOf('enqueueBuilderSelfReflectionSafe(row.id)', abandonIdx);
  const activateCall = src.indexOf('enqueueBuilderSelfReflectionSafe(row.id)', activateIdx);
  assert.ok(abandonIdx >= 0 && abandonCall > abandonIdx, 'abandon must enqueue after success');
  assert.ok(activateIdx >= 0 && activateCall > activateIdx, 'activation must enqueue after success');
  assert.notEqual(abandonCall, activateCall);
});

await test('(a) activation/abandon 後產生 PENDING 提案且 dedupeKey 去重生效', async () => {
  const dir = useRoots('a-dedupe');
  const item = candidate({ dedupeKey: `dedupe-${ulid()}` });
  setBuilderLessonRunAgentForTest(mockRunAgent({ candidates: [item] }));
  const seeded = await seedSession({ status: 'DISCOVERY' });
  try {
    await abandonBuilderSession({ sessionId: seeded.sessionId, userId: seeded.userId });
    const first = await proposalsForSession(seeded.sessionId);
    assert.equal(first.length, 1, 'abandon should create one pending lesson proposal');
    const change = asRecord(first[0]!.proposedChange);
    assert.equal(change?.action, BUILDER_LESSON_ACTION);
    assert.equal(change?.title, item.title);
    assert.equal(change?.lessonText, item.lessonText);
    assert.equal(change?.dedupeKey, item.dedupeKey);
    assert.equal(first[0]!.status, 'PENDING');
    assert.match(String(change?.fileName), /^lesson-.*\.section.md$/);
    assert.ok(typeof change?.contentMd === 'string' && String(change.contentMd).includes(item.lessonText));

    await enqueueBuilderSelfReflection(seeded.sessionId);
    const second = await proposalsForSession(seeded.sessionId);
    assert.equal(second.length, 1, 'dedupeKey must prevent a second PENDING proposal');
    assert.equal(second[0]!.id, first[0]!.id);
    assert.equal(fs.existsSync(path.join(dir, String(change?.fileName))), false, 'must not auto-adopt');
  } finally {
    await cleanupSession(seeded.sessionId);
  }
});

await test('(b) approve 後 lesson 檔落地、frontmatter 正確、redact 生效、assemblePrompt 含該教訓', async () => {
  const dir = useRoots('b-approve');
  const item = candidate({
    dedupeKey: `redact-${ulid()}`,
    lessonText: `不要在第一輪就要檔案；先問目的。金鑰 ${SECRET_KEY} 不得寫進規則。`,
  });
  setBuilderLessonRunAgentForTest(mockRunAgent({ candidates: [item] }));
  const seeded = await seedSession({ status: 'ACTIVE' });
  try {
    await enqueueBuilderSelfReflection(seeded.sessionId);
    const pending = await proposalsForSession(seeded.sessionId);
    assert.equal(pending.length, 1);
    const approved = await approveProposal(pending[0]!.id, DECIDED_BY);
    assert.equal(approved.proposal.status, 'APPROVED');

    const fileName = lessonFileNameFor(item.title, item.dedupeKey);
    const abs = path.join(dir, fileName);
    assert.equal(fs.existsSync(abs), true, `missing ${fileName}`);
    const raw = fs.readFileSync(abs, 'utf8');
    assert.match(raw, /^---\n/);
    assert.match(raw, new RegExp(`name: ${fileName.replace('.section.md', '')}`));
    assert.match(raw, /order: 200/);
    assert.match(raw, /enabled: true/);
    assert.match(raw, /origin: lesson/);
    assert.match(raw, /stages: \[interview\]/);
    assert.match(raw, /dedupeKey:/);
    assert.match(raw, /不要在第一輪就要檔案；先問目的。/);
    assert.match(raw, /\[REDACTED_API_KEY\]/);
    assert.equal(raw.includes(SECRET_KEY), false);
    assert.equal(raw.includes('{{'), false);

    resetPromptAssemblyCache();
    const assembled = assemblePrompt({ stage: 'interview', vars: {} });
    const sectionName = fileName.replace('.section.md', '');
    assert.ok(assembled.sectionsUsed.includes(sectionName), `sectionsUsed missing ${sectionName}: ${assembled.sectionsUsed.join(',')}`);
    assert.match(assembled.systemPrompt, /不要在第一輪就要檔案；先問目的。/);
    assert.match(assembled.systemPrompt, /\[REDACTED_API_KEY\]/);
    assert.equal(assembled.systemPrompt.includes(SECRET_KEY), false);
  } finally {
    await cleanupSession(seeded.sessionId);
  }
});

await test('(c) reject 不落檔', async () => {
  const dir = useRoots('c-reject');
  const item = candidate({ dedupeKey: `reject-${ulid()}` });
  setBuilderLessonRunAgentForTest(mockRunAgent({ candidates: [item] }));
  const seeded = await seedSession({ status: 'ACTIVE' });
  try {
    await enqueueBuilderSelfReflection(seeded.sessionId);
    const pending = await proposalsForSession(seeded.sessionId);
    assert.equal(pending.length, 1);
    const fileName = String(asRecord(pending[0]!.proposedChange)?.fileName);
    const rejected = await rejectProposal(pending[0]!.id, DECIDED_BY);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(fs.existsSync(path.join(dir, fileName)), false);
    const assembled = assemblePrompt({ stage: 'interview', vars: {} });
    assert.equal(assembled.sectionsUsed.some((name) => name.startsWith('lesson-')), false);
    assert.equal(assembled.systemPrompt.includes(item.lessonText), false);
  } finally {
    await cleanupSession(seeded.sessionId);
  }
});

await test('(d) 第 21 條觸發合併提案', async () => {
  const dir = useRoots('d-merge');
  for (let i = 0; i < BUILDER_LESSON_CAP; i += 1) writeDummyLesson(dir, i);
  const leftovers = await prisma.changeProposal.findMany({
    where: { status: 'PENDING', proposedBy: 'system', source: 'REFLECTION' },
  });
  const leftoverIds = leftovers
    .filter((row) => {
      const rec = asRecord(row.proposedChange);
      return rec?.action === BUILDER_LESSON_MERGE_ACTION
        && typeof rec.sessionId === 'string'
        && rec.sessionId.startsWith(TEST_PREFIX);
    })
    .map((row) => row.id);
  if (leftoverIds.length) {
    await prisma.changeProposal.deleteMany({ where: { id: { in: leftoverIds } } });
  }

  const item = candidate({
    dedupeKey: `twenty-first-${ulid()}`,
    title: '第21條：測試一次過才送審',
    lessonText: '測試未一次通過時，先問失敗案例再送審；不要直接宣稱已可用。',
  });
  setBuilderLessonRunAgentForTest(mockRunAgent({ candidates: [item] }));
  const seeded = await seedSession({ status: 'ACTIVE' });
  try {
    const before = new Set(
      (await prisma.changeProposal.findMany({ where: { status: 'PENDING' }, select: { id: true } }))
        .map((row) => row.id),
    );
    await enqueueBuilderSelfReflection(seeded.sessionId);
    const pending = await proposalsForSession(seeded.sessionId);
    assert.equal(pending.length, 1);
    await approveProposal(pending[0]!.id, DECIDED_BY);

    const fileName = lessonFileNameFor(item.title, item.dedupeKey);
    assert.equal(fs.existsSync(path.join(dir, fileName)), true);
    const adopted = fs.readdirSync(dir).filter((name) => name.startsWith('lesson-') && name.endsWith('.section.md'));
    assert.equal(adopted.length, BUILDER_LESSON_CAP + 1);

    const created = (await prisma.changeProposal.findMany({ where: { status: 'PENDING' } }))
      .filter((row) => !before.has(row.id) && row.id !== pending[0]!.id);
    const merge = created.find((row) => asRecord(row.proposedChange)?.action === BUILDER_LESSON_MERGE_ACTION);
    assert.ok(merge, '21st adopted lesson must create a merge proposal');
    const change = asRecord(merge!.proposedChange);
    assert.equal(change?.dedupeKey, 'builder-prompt-lesson-merge');
    assert.ok(Array.isArray(change?.overlapping) && (change?.overlapping as unknown[]).length > 0);
    assert.equal(change?.adoptedCount, BUILDER_LESSON_CAP + 1);
    assert.equal(merge!.status, 'PENDING');
  } finally {
    await cleanupSession(seeded.sessionId);
  }
});

await test('(e) lessonText 含 {{ 時被拒收（ingest：不建提案）', async () => {
  useRoots('e-mustache');
  const item = candidate({
    dedupeKey: `mustache-${ulid()}`,
    lessonText: '把客戶原話寫進 {{rolePrompt}} 再問下一題。',
  });
  setBuilderLessonRunAgentForTest(mockRunAgent({ candidates: [item] }));
  const seeded = await seedSession({ status: 'ACTIVE' });
  try {
    await enqueueBuilderSelfReflection(seeded.sessionId);
    const pending = await proposalsForSession(seeded.sessionId);
    assert.equal(pending.length, 0, 'mustache candidates must not enter the inbox');
  } finally {
    await cleanupSession(seeded.sessionId);
  }
});

setBuilderLessonRunAgentForTest();
if (originalQueue === undefined) delete process.env.AIOS_BUILDER_EVOLUTION_QUEUE;
else process.env.AIOS_BUILDER_EVOLUTION_QUEUE = originalQueue;

resetPromptAssemblyCache();
setPromptAssemblyRootsForTest();
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  // best-effort
}

await prisma.agentBuildSession.deleteMany({
  where: { id: { startsWith: TEST_PREFIX } },
}).catch(() => {});

await disconnectDb();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
