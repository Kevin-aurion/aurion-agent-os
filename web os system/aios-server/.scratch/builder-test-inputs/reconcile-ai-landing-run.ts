import { prisma } from '../../src/lib/db.js';
import { audit } from '../../src/lib/audit.js';
import { deepRedactSecrets } from '../../src/memory/deepredact.js';

const sessionId = '01KZKJQ5VX86TCA0XWRHJ4ZNEZ';
const runId = '01KZKQHH239WKZZT4G0YMA8RX2';

const session = await prisma.agentBuildSession.findUniqueOrThrow({ where: { id: sessionId } });
const run = await prisma.run.findUniqueOrThrow({
  where: { id: runId },
  include: { steps: { orderBy: { round: 'asc' } } },
});
if (run.status === 'RUNNING') throw new Error('Refusing to reconcile a running test');

const last = run.steps.at(-1);
const summary = `試跑未通過（狀態：${run.status}${run.stoppedAt ? `，停在 ${run.stoppedAt}` : ''}）`;
const detail = deepRedactSecrets(last?.verdict ?? '未取得驗證判決');
const assistantMessage = `試跑未通過：${summary}`;
const transcript = Array.isArray(session.transcript) ? [...session.transcript] : [];
transcript.push({ role: 'assistant', content: assistantMessage, at: new Date().toISOString() });

await prisma.agentBuildSession.update({
  where: { id: sessionId },
  data: {
    status: 'FAILED',
    lastRunId: runId,
    testResult: deepRedactSecrets({
      ok: false,
      status: 'FAILED',
      runId,
      summary,
      detail: detail.slice(0, 1500),
      productionBlockers: [],
    }) as object,
    transcript: deepRedactSecrets(transcript) as object,
    lastAssistantMessage: assistantMessage,
  },
});
await audit(session.userId, 'agent_builder.test_reconciled', 'AgentBuildSession', sessionId, {
  runId,
  status: run.status,
  rounds: run.steps.length,
});
await prisma.$disconnect();
console.log(JSON.stringify({ sessionId, runId, runStatus: run.status, rounds: run.steps.length }));
