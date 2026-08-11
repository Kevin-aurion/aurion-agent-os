import { ulid } from 'ulid';
import { prisma } from '../../src/lib/db.js';
import { audit } from '../../src/lib/audit.js';
import { deepRedactSecrets } from '../../src/memory/deepredact.js';
import { normalizeTestInputRequirements } from '../../src/lib/buildertestinputs.js';

const SESSION_ID = '01KZKJQ5VX86TCA0XWRHJ4ZNEZ';

const session = await prisma.agentBuildSession.findUnique({
  where: { id: SESSION_ID },
  include: { iterations: { orderBy: { sequence: 'desc' }, take: 1 } },
});
if (!session) throw new Error('AI 落地提案師 session not found');
const latest = session.iterations[0];
if (!latest?.artifactSnapshot || typeof latest.artifactSnapshot !== 'object' || Array.isArray(latest.artifactSnapshot)) {
  throw new Error('Latest harness snapshot not found');
}
const current = latest.artifactSnapshot as Record<string, unknown>;
const requirements = normalizeTestInputRequirements([
  {
    key: 'meeting_transcript',
    label: '會議逐字稿',
    description: '請上傳一份客戶會議逐字稿；建議使用 SRT，也接受 VTT 或 TXT。',
    kind: 'FILE',
    required: true,
    acceptedExtensions: ['.srt', '.vtt', '.txt'],
    minFiles: 1,
    maxFiles: 1,
  },
  {
    key: 'requirement_documents',
    label: '需求文件',
    description: '如有需求書或補充規格可一併提供；未提供仍可執行本次測試。',
    kind: 'FILE',
    required: false,
    acceptedExtensions: ['.pdf', '.docx', '.md', '.txt'],
    minFiles: 0,
    maxFiles: 3,
  },
]);
const alreadyUpdated = Array.isArray(current.testInputRequirements)
  && (current.testInputRequirements as Array<Record<string, unknown>>).some((item) => item.key === 'meeting_transcript');
if (alreadyUpdated) {
  console.log(JSON.stringify({ changed: false, sequence: latest.sequence, sessionStatus: session.status }));
  await prisma.$disconnect();
  process.exit(0);
}

const nextSequence = latest.sequence + 1;
const snapshot = deepRedactSecrets({ ...current, testInputRequirements: requirements });
const iteration = await prisma.agentBuildIteration.create({
  data: {
    id: ulid(),
    sessionId: session.id,
    sequence: nextSequence,
    basedOnIterationId: latest.id,
    triggerKind: 'system',
    triggerSummary: '依 Agent 工作內容補齊測試輸入契約：會議逐字稿必填，需求文件選填。',
    status: 'READY',
    understanding: latest.understanding ?? undefined,
    proposedChanges: deepRedactSecrets([{
      area: 'test',
      action: 'updated',
      summary: '建立可勾選的測試資料需求清單',
      reason: '每位 Agent 的測試輸入不同，必須在試跑前明確驗證必填資料。',
    }]),
    artifactSnapshot: snapshot,
    userSummary: '已補上測試資料清單：會議逐字稿為必填，需求文件為選填。',
    fdeSummary: '新增 testInputRequirements；後端會在缺少 meeting_transcript 時拒絕試跑。',
    startedAt: new Date(),
    completedAt: new Date(),
  },
});
await audit(session.userId, 'agent_builder.test_contract_backfilled', 'AgentBuildSession', session.id, {
  iterationId: iteration.id,
  requiredKeys: requirements.filter((item) => item.required).map((item) => item.key),
});
console.log(JSON.stringify({ changed: true, sequence: iteration.sequence, iterationId: iteration.id, sessionStatus: session.status }));
await prisma.$disconnect();
