/**
 * Ticket 04 — Codex Computer Use MCP bridge.
 * Run: npx tsx .scratch/agent-training-governance/tests/t04.test.ts
 *
 * Seams:
 * 1. connectComputerUse + tools/list → 10 tools
 * 2. assertToolsPresent → throw on missing tools (version-drift guard)
 * 3. computerUse=false → still hard-reject (no regression of ticket 03)
 * 4. Permission/auth failures surface a readable Chinese/English message
 *
 * Does NOT start a 30-minute recording. Does not require successful desktop
 * automation (list_apps may return isError when process is unauthenticated).
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { runAgent } from '../../../src/engine/runner.js';
import {
  connectComputerUse,
  assertToolsPresent,
  type McpClient,
} from '../../../src/lib/codexmcp.js';

const EXPECTED_CU_TOOLS = [
  'list_apps',
  'get_app_state',
  'click',
  'perform_secondary_action',
  'set_value',
  'select_text',
  'scroll',
  'drag',
  'press_key',
  'type_text',
];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main() {
  console.log('── t04: Codex Computer Use bridge ──');

  // ── 1. Live MCP: connect + 10 tools ──────────────────────────────────────
  console.log('\n── [1] connectComputerUse + listTools ──');
  let client: McpClient | null = null;
  try {
    client = await connectComputerUse();
    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log('tools:', names.join(', '));
    assert(tools.length === 10, `expected 10 tools, got ${tools.length}`);
    for (const n of EXPECTED_CU_TOOLS) {
      assert(names.includes(n), `missing tool: ${n}`);
    }
    await assertToolsPresent(client, EXPECTED_CU_TOOLS);
    console.log('assertToolsPresent(all 10): OK');

    // ── 2. Missing tool → clear error ──────────────────────────────────────
    console.log('\n── [2] assertToolsPresent missing tool ──');
    let threw = false;
    try {
      await assertToolsPresent(client, ['list_apps', 'this_tool_does_not_exist_xyz']);
    } catch (e) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      console.log('error:', msg);
      assert(/this_tool_does_not_exist_xyz|missing|缺少|工具/i.test(msg), `error should name missing tool: ${msg}`);
    }
    assert(threw, 'assertToolsPresent should throw when tools missing');

    // ── 3. list_apps call (may be isError if unauthenticated) ───────────────
    console.log('\n── [3] list_apps call (permission path) ──');
    try {
      const result = await client.call('list_apps', {});
      console.log('list_apps result head:', JSON.stringify(result).slice(0, 400));
      // Either success content or isError — both prove tools/call works.
      assert(result != null, 'list_apps should return something');
      const text = JSON.stringify(result);
      if (/not authenticated|accessibility|permission|輔助使用|權限/i.test(text)) {
        console.log('auth/permission signal present in tool result (expected outside Codex app)');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log('list_apps threw:', msg);
      assert(
        /authenticated|輔助使用|權限|Computer Use|accessibility|permission|timeout/i.test(msg),
        `permission-ish error should be readable: ${msg}`,
      );
    }
  } finally {
    client?.close();
  }

  // ── 4. Hard gate: computerUse=false still rejects ────────────────────────
  console.log('\n── [4] computerUse=false hard reject (no regression) ──');
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need OWNER/TRAINER user');

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const wfId = ulid();
  const stepId = ulid();
  let runId: string | null = null;

  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t04-cc-off-${tag}`,
        name: 'T04 ComputerUse Off',
        description: 'temp t04',
        rolePrompt: 'test',
        engineExecute: 'CODEX',
        createdBy: owner.id,
        riskTier: 'low',
        restrictions: {
          webSearch: false,
          computerUse: false,
          sendEmail: false,
          cloudWrite: false,
          shell: false,
        },
      },
    });
    await prisma.workflow.create({
      data: {
        id: wfId,
        agentId,
        name: 't04-cc-wf',
        description: 't04 computer control hard-block',
        enabled: true,
        trigger: { type: 'MANUAL' },
        steps: {
          create: [
            {
              id: stepId,
              position: 0,
              stepKey: 'desktop',
              type: 'COMPUTER_CONTROL',
              config: { skillId: 'dummy-skill', instructions: 'list apps' },
            },
          ],
        },
      },
    });

    const outcome = await runAgent({
      agentId,
      workflowId: wfId,
      input: { message: 't04 hard gate' },
      triggeredBy: owner.id,
    });
    runId = outcome.runId;
    console.log('ok:', outcome.ok, 'stoppedAt:', outcome.stoppedAt);
    console.log('reason:', outcome.results[0]?.reason?.slice(0, 200));
    assert(outcome.ok === false, 'step must fail when computerUse=false');
    const reason = outcome.results[0]?.reason ?? '';
    assert(/RESTRICTED|電腦操控|computerUse/i.test(reason), `reason should be restriction: ${reason}`);
  } finally {
    if (runId) {
      await prisma.runStep.deleteMany({ where: { runId } }).catch(() => {});
      await prisma.computerControlTask.deleteMany({ where: { runId } }).catch(() => {});
      await prisma.changeProposal.deleteMany({ where: { runId } }).catch(() => {});
      await prisma.run.deleteMany({ where: { id: runId } }).catch(() => {});
    }
    await prisma.workflowStep.deleteMany({ where: { workflowId: wfId } }).catch(() => {});
    await prisma.workflow.deleteMany({ where: { id: wfId } }).catch(() => {});
    await prisma.changeProposal.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
  }

  console.log('\n✅ t04 ALL PASSED');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n❌ t04 FAILED:', e);
    process.exit(1);
  });
