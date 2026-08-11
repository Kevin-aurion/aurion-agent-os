import assert from 'node:assert/strict';
import { prisma } from '../../../src/lib/db.js';
import { listBuilderEvolutionSessions } from '../../../src/lib/agentbuilder.js';

const user = await prisma.user.findUniqueOrThrow({ where: { email: 'kevin@lazyoffice.app' } });
const sessions = await listBuilderEvolutionSessions({ userId: user.id, role: user.role });
const target = sessions.find((session) => session.id === '01KZKJQ5VX86TCA0XWRHJ4ZNEZ');
assert(target, 'AI 落地提案師 session must be visible');
assert(target.testProgress, 'latest builder test progress must be hydrated');
assert.equal(target.testProgress.runId.length > 10, true);
assert.equal(target.testProgress.maxRounds, 5);
assert.equal(target.testProgress.elapsedSeconds >= 0, true);
assert.equal(Array.isArray(target.testProgress.rounds), true);
console.log(JSON.stringify({
  sessionStatus: target.status,
  runId: target.testProgress.runId,
  stage: target.testProgress.stage,
  round: target.testProgress.currentRound,
  roundsRecorded: target.testProgress.rounds.length,
}));
await prisma.$disconnect();
