import assert from 'node:assert/strict';
import { prisma } from '../../../src/lib/db.js';
import { runBuilderTest } from '../../../src/lib/agentbuilder.js';

const sessionId = '01KZKJQ5VX86TCA0XWRHJ4ZNEZ';
const session = await prisma.agentBuildSession.findUnique({ where: { id: sessionId } });
assert.ok(session, 'AI 落地提案師 session must exist');
assert.equal(session.testData, null, 'negative gate test requires an empty fixture set');

let runnerCalled = false;
await assert.rejects(
  runBuilderTest({
    sessionId,
    userId: session.userId,
    role: 'OWNER',
    runAgentFn: async () => {
      runnerCalled = true;
      throw new Error('runner must not execute');
    },
  }),
  /Test data is required|Required test data is incomplete/,
);
assert.equal(runnerCalled, false, 'runtime must remain untouched when required fixtures are missing');
console.log(JSON.stringify({ passed: true, runnerCalled }));
await prisma.$disconnect();
