/**
 * Session-agent binding — intent classifier regression.
 * Uses Hank (hank@aurion-group.com) real first-user messages as fixtures.
 *
 * Run: npx tsx .scratch/session-agent-binding/tests/t01-intent.test.ts
 *
 * Seam: isExplicitAgentBuildPrompt
 */
import { prisma } from '../../../src/lib/db.js';
import { isExplicitAgentBuildPrompt } from '../../../src/lib/externalagentbuilder.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function firstUserText(transcript: unknown): string {
  if (!Array.isArray(transcript)) return '';
  for (const entry of transcript) {
    const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
    if (row?.role === 'user' && typeof row.content === 'string' && row.content.trim()) {
      return row.content;
    }
  }
  return '';
}

const hank = await prisma.user.findFirst({
  where: { email: 'hank@aurion-group.com' },
  select: { id: true, email: true },
});
assert(hank, 'Hank user hank@aurion-group.com must exist');

const sessions = await prisma.agentBuildSession.findMany({
  where: { userId: hank.id },
  orderBy: { createdAt: 'asc' },
  select: { id: true, status: true, createdAt: true, transcript: true },
});
assert(sessions.length === 12, `expected 12 Hank sessions, got ${sessions.length}`);

type Row = {
  n: number;
  id: string;
  status: string;
  hit: boolean;
  preview: string;
};
const results: Row[] = [];
sessions.forEach((session, index) => {
  const text = firstUserText(session.transcript);
  const hit = isExplicitAgentBuildPrompt(text);
  const row: Row = {
    n: index + 1,
    id: session.id,
    status: session.status,
    hit,
    preview: text.slice(0, 120).replaceAll('\n', ' '),
  };
  results.push(row);
  console.log(JSON.stringify(row));
});

const first = results[0]!;
assert(first.hit === true, `session 1 (Vincent MCP / 建立+agent) must be true, got ${first.hit}`);

const second = results[1]!;
const third = results[2]!;
console.log('SESSION_2_ACTUAL', {
  id: second.id,
  hit: second.hit,
  note: 'Originally false (old object regex missed「AIOS 員工」; entered via start_agent_build). After AI(?:OS)? object tightening this prompt is a true explicit build in one sentence.',
});
console.log('SESSION_3_ACTUAL', {
  id: third.id,
  hit: third.hit,
  note: 'Originally false: 「測試員工」is not AI/AIOS 員工/agent/skill; entered via explicit start_agent_build.',
});

const scheduleRows = results.slice(3);
assert(scheduleRows.length === 9, `expected 9 schedule sessions, got ${scheduleRows.length}`);
const scheduleFalse = scheduleRows.filter((row) => row.hit);
assert(
  scheduleFalse.length === 0,
  `schedule prompts must all be false; still matching: ${scheduleFalse.map((row) => `${row.n}:${row.id}`).join(', ')}`,
);

assert(
  isExplicitAgentBuildPrompt('幫我建立一個財務管理 agent') === true,
  'tight explicit create+agent must remain true',
);
assert(
  isExplicitAgentBuildPrompt('我想要一個財務管理 agent') === false,
  'generic 想要+agent must no longer match',
);
assert(
  isExplicitAgentBuildPrompt('請解釋 agent 這個英文單字') === false,
  'unrelated agent mention must stay false',
);
assert(
  isExplicitAgentBuildPrompt('幫我建立一位每天整理客戶回饋的 AI 員工') === true,
  'a requested daily employee is a build, not a schedule execution prompt',
);
assert(
  isExplicitAgentBuildPrompt('不要建立新的 Agent，我只是在討論設計。') === false,
  'negated creation must not open a build',
);
assert(
  isExplicitAgentBuildPrompt('凌晨 4:30，執行 Savia 每日自我進化，更新技能 playbook。') === false,
  'scheduled maintenance must not open a build',
);
assert(
  isExplicitAgentBuildPrompt('你是 AIOS 的「員工演進建築師」。請把本輪新理解編譯成下一版非生效 Agent 草稿。Harness 是 shadow draft。輸出純 JSON，鍵為 understanding、harness、suggestTest。') === false,
  'internal evolution prompts must not recursively open a build',
);
assert(
  isExplicitAgentBuildPrompt('請幫我分析目前 Agent Builder 系統架構與程式碼，最後整理成 HTML 報告與規劃。') === false,
  'architecture analysis must not be treated as employee creation',
);

console.log(JSON.stringify({
  passed: true,
  session1: first.hit,
  session2: second.hit,
  session3: third.hit,
  scheduleAllFalse: true,
}, null, 2));

await prisma.$disconnect();
