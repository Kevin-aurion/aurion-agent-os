/**
 * Pure self-test: Workbench V2 worksession projection contract
 * (createWorkSession / reduceSessionFrame / stepTypeLabel /
 *  projectRunDetail / visibleWorkbenchControls).
 *
 * Run: npx tsx src/lib/worksession.selftest.ts
 *
 * Round 1 TDD RED: worksession.ts does not exist yet — this file is expected
 * to fail until Round 2 implements the module.
 */
import {
  createWorkSession,
  reduceSessionFrame,
  stepTypeLabel,
  projectRunDetail,
  visibleWorkbenchControls,
  shouldBindRunStart,
  MAX_SESSION_LOGS,
} from './worksession';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function main() {
  // ── 1. createWorkSession initial shape ──────────────────────────────────
  {
    const s = createWorkSession('r1');
    assert(s.runId === 'r1', '1: runId is r1');
    assert(s.status === 'idle', '1: status idle');
    assert(Array.isArray(s.steps) && s.steps.length === 0, '1: steps empty');
    assert(Array.isArray(s.logs) && s.logs.length === 0, '1: logs empty');
    assert(s.approvalPending === false, '1: approvalPending false');
    assert(s.finishedStatus === null, '1: finishedStatus null');
  }

  // ── 2. run.started sets runId + running; immutability of input state ────
  {
    const idle = createWorkSession(null);
    const before = deepClone(idle);
    const next = reduceSessionFrame(idle, {
      topic: 'run.started',
      payload: {
        runId: 'run-abc',
        agentId: 'a1',
        workflowId: 'w1',
        triggeredBy: 'manual',
        startedAt: '2026-01-01T00:00:00Z',
      },
    });
    assert(next !== idle, '2: returns new object');
    assert(next.runId === 'run-abc', '2: runId set from started');
    assert(next.status === 'running', '2: status running');
    assert(JSON.stringify(idle) === JSON.stringify(before), '2: input state not mutated');
  }

  // ── 3. run.step forward + in-place update by stepKey+round ──────────────
  {
    let s = createWorkSession('r-step');
    s = reduceSessionFrame(s, {
      topic: 'run.started',
      payload: { runId: 'r-step', agentId: 'a', workflowId: 'w', triggeredBy: 'm', startedAt: 't' },
    });
    s = reduceSessionFrame(s, {
      topic: 'run.step',
      payload: {
        runId: 'r-step',
        stepKey: 'fetch',
        type: 'TOOL',
        round: 1,
        phase: 'executing',
      },
    });
    assert(s.steps.length === 1, '3: one step after first');
    const step0 = s.steps[0];
    assert(step0.stepKey === 'fetch', '3: stepKey');
    assert(step0.round === 1, '3: round');
    assert(step0.phase === 'executing', '3: phase executing');
    assert(step0.kindLabel === '使用工具', '3: kindLabel 使用工具');
    assert(step0.isTool === true, '3: isTool true for TOOL');

    s = reduceSessionFrame(s, {
      topic: 'run.step',
      payload: {
        runId: 'r-step',
        stepKey: 'fetch',
        type: 'TOOL',
        round: 1,
        phase: 'approved',
      },
    });
    assert(s.steps.length === 1, '3: same stepKey+round updates in place, not append');
    assert(s.steps[0].phase === 'approved', '3: phase updated to approved');
    assert(s.steps[0].stepKey === 'fetch', '3: stepKey still fetch');
    assert(s.steps[0].round === 1, '3: round still 1');
  }

  // ── 4. Langflow / Native same UI shape ──────────────────────────────────
  {
    const base = createWorkSession('r-lf');
    const withStarted = reduceSessionFrame(base, {
      topic: 'run.started',
      payload: { runId: 'r-lf', agentId: 'a', workflowId: 'w', triggeredBy: 'm', startedAt: 't' },
    });

    const nativeFrame = {
      topic: 'run.step',
      payload: {
        runId: 'r-lf',
        stepKey: 'node-1',
        type: 'DO',
        round: 0,
        phase: 'executing',
      },
    };
    const langflowFrame = {
      topic: 'run.step',
      payload: {
        runId: 'r-lf',
        stepKey: 'node-1',
        type: 'DO',
        round: 0,
        phase: 'executing',
        runtimeKind: 'LANGFLOW',
        flowNodeId: 'fn-xyz',
      },
    };

    const nativeState = reduceSessionFrame(withStarted, nativeFrame);
    const langflowState = reduceSessionFrame(withStarted, langflowFrame);

    assert(nativeState.steps.length === 1 && langflowState.steps.length === 1, '4: both have one step');
    const nKeys = Object.keys(nativeState.steps[0]).sort();
    const lKeys = Object.keys(langflowState.steps[0]).sort();
    assert(JSON.stringify(nKeys) === JSON.stringify(lKeys), '4: SessionStep keys equal after sort');
    assert(nativeState.steps[0].stepKey === langflowState.steps[0].stepKey, '4: stepKey same');
    assert(nativeState.steps[0].round === langflowState.steps[0].round, '4: round same');
    assert(nativeState.steps[0].phase === langflowState.steps[0].phase, '4: phase same');
    assert(nativeState.steps[0].kindLabel === langflowState.steps[0].kindLabel, '4: kindLabel same');
    assert(nativeState.steps[0].isTool === langflowState.steps[0].isTool, '4: isTool same');

    const lfJson = JSON.stringify(langflowState);
    assert(!lfJson.includes('flowNodeId'), '4: stringify must not contain flowNodeId');
    assert(!lfJson.includes('runtimeKind'), '4: stringify must not contain runtimeKind');
  }

  // ── 5. Unknown / invalid frames: return same reference, never throw ─────
  {
    const s = createWorkSession('r-safe');
    const sRunning = reduceSessionFrame(s, {
      topic: 'run.started',
      payload: { runId: 'r-safe', agentId: 'a', workflowId: 'w', triggeredBy: 'm', startedAt: 't' },
    });

    const mystery = reduceSessionFrame(sRunning, {
      topic: 'runtime.mystery',
      payload: { runId: 'r-safe', foo: 1 },
    });
    assert(mystery === sRunning, '5: unknown topic returns same ref');

    const nonObj = reduceSessionFrame(sRunning, {
      topic: 'run.step',
      payload: 'not-an-object',
    });
    assert(nonObj === sRunning, '5: non-object payload returns same ref');

    const wrongRun = reduceSessionFrame(sRunning, {
      topic: 'run.step',
      payload: {
        runId: 'other-run',
        stepKey: 'x',
        type: 'DO',
        round: 1,
        phase: 'executing',
      },
    });
    assert(wrongRun === sRunning, '5: mismatched runId returns same ref');

    const missingPhase = reduceSessionFrame(sRunning, {
      topic: 'run.step',
      payload: {
        runId: 'r-safe',
        stepKey: 'x',
        type: 'DO',
        round: 1,
        // phase missing
      },
    });
    assert(missingPhase === sRunning, '5: run.step without phase returns same ref');

    // null runId: only run.started may bind; other topics ignored
    const unbound = createWorkSession(null);
    const ignoreLog = reduceSessionFrame(unbound, {
      topic: 'run.log',
      payload: { runId: 'any', line: 'hello' },
    });
    assert(ignoreLog === unbound, '5: unbound runId ignores non-started');
  }

  // ── 6. run.log append + MAX_SESSION_LOGS cap (drop oldest) ──────────────
  {
    assert(typeof MAX_SESSION_LOGS === 'number' && MAX_SESSION_LOGS === 200, '6: MAX_SESSION_LOGS is 200');
    let s = createWorkSession('r-log');
    s = reduceSessionFrame(s, {
      topic: 'run.started',
      payload: { runId: 'r-log', agentId: 'a', workflowId: 'w', triggeredBy: 'm', startedAt: 't' },
    });
    const total = MAX_SESSION_LOGS + 5;
    for (let i = 0; i < total; i++) {
      s = reduceSessionFrame(s, {
        topic: 'run.log',
        payload: { runId: 'r-log', line: `line-${i}` },
      });
    }
    assert(s.logs.length === MAX_SESSION_LOGS, '6: logs capped at MAX_SESSION_LOGS');
    assert(s.logs[s.logs.length - 1] === `line-${total - 1}`, '6: newest line retained');
    assert(!s.logs.includes('line-0'), '6: oldest line-0 dropped');
    assert(!s.logs.includes('line-1'), '6: oldest line-1 dropped');
    assert(!s.logs.includes('line-2'), '6: oldest line-2 dropped');
    assert(!s.logs.includes('line-3'), '6: oldest line-3 dropped');
    assert(!s.logs.includes('line-4'), '6: oldest line-4 dropped');
    assert(s.logs.includes('line-5'), '6: first kept line is line-5');
  }

  // ── 7. approval.requested: pending + no resumeToken leak ────────────────
  {
    let s = createWorkSession('r-appr');
    s = reduceSessionFrame(s, {
      topic: 'run.started',
      payload: { runId: 'r-appr', agentId: 'a', workflowId: 'w', triggeredBy: 'm', startedAt: 't' },
    });
    const secret = 'tok-secret-123';
    s = reduceSessionFrame(s, {
      topic: 'approval.requested',
      payload: { runId: 'r-appr', agentId: 'a1', resumeToken: secret },
    });
    assert(s.approvalPending === true, '7: approvalPending true');
    assert(s.status === 'awaiting_approval', '7: status awaiting_approval');
    const json = JSON.stringify(s);
    assert(!json.includes('resumeToken'), '7: key resumeToken never in state');
    assert(!json.includes(secret), '7: token value never in state');
  }

  // ── 8. run.step phase awaiting_review → awaiting_approval ───────────────
  {
    let s = createWorkSession('r-rev');
    s = reduceSessionFrame(s, {
      topic: 'run.started',
      payload: { runId: 'r-rev', agentId: 'a', workflowId: 'w', triggeredBy: 'm', startedAt: 't' },
    });
    s = reduceSessionFrame(s, {
      topic: 'run.step',
      payload: {
        runId: 'r-rev',
        stepKey: 'gate',
        type: 'CONDITION',
        round: 1,
        phase: 'awaiting_review',
      },
    });
    assert(s.status === 'awaiting_approval', '8: status awaiting_approval');
    assert(s.approvalPending === true, '8: approvalPending true');
    assert(s.steps.length === 1, '8: step recorded');
    assert(s.steps[0].phase === 'awaiting_review', '8: phase kept as awaiting_review');
    assert(s.steps[0].kindLabel === '判斷', '8: CONDITION → 判斷');
    assert(s.steps[0].isTool === false, '8: CONDITION isTool false');
  }

  // ── 9. run.finished SUCCEEDED / FAILED; clear approvalPending ───────────
  {
    let s = createWorkSession('r-fin');
    s = reduceSessionFrame(s, {
      topic: 'run.started',
      payload: { runId: 'r-fin', agentId: 'a', workflowId: 'w', triggeredBy: 'm', startedAt: 't' },
    });
    s = reduceSessionFrame(s, {
      topic: 'approval.requested',
      payload: { runId: 'r-fin', agentId: 'a', resumeToken: 'tok-x' },
    });
    assert(s.approvalPending === true, '9: pending before finish');

    const ok = reduceSessionFrame(s, {
      topic: 'run.finished',
      payload: { runId: 'r-fin', agentId: 'a', status: 'SUCCEEDED', stoppedAt: 't2' },
    });
    assert(ok.status === 'finished', '9: SUCCEEDED → finished');
    assert(ok.finishedStatus === 'SUCCEEDED', '9: finishedStatus SUCCEEDED');
    assert(ok.approvalPending === false, '9: approvalPending cleared on SUCCEEDED');

    const fail = reduceSessionFrame(s, {
      topic: 'run.finished',
      payload: { runId: 'r-fin', agentId: 'a', status: 'FAILED', stoppedAt: 't2' },
    });
    assert(fail.status === 'failed', '9: FAILED → failed');
    assert(fail.finishedStatus === 'FAILED', '9: finishedStatus FAILED');
    assert(fail.approvalPending === false, '9: approvalPending cleared on FAILED');
  }

  // ── 10. stepTypeLabel full table + unknown; no tech terms ───────────────
  {
    const table: Array<[string | null | undefined, string]> = [
      ['DO', '處理'],
      ['TOOL', '使用工具'],
      ['AGENT', '協作'],
      ['CONDITION', '判斷'],
      ['NOTIFY', '通知'],
      ['COMPUTER_CONTROL', '操作電腦'],
      ['WEIRD', '處理步驟'],
      [null, '處理步驟'],
      [undefined, '處理步驟'],
      ['', '處理步驟'],
    ];
    const banned = ['MCP', 'manifest', 'JSON', 'Flow'];
    for (const [input, expected] of table) {
      const label = stepTypeLabel(input);
      assert(label === expected, `10: stepTypeLabel(${String(input)}) → ${expected}, got ${label}`);
      for (const b of banned) {
        assert(!label.includes(b), `10: label for ${String(input)} must not contain ${b}`);
      }
    }
    // COMPUTER_CONTROL isTool semantics covered in reduce; label must not say MCP
    assert(stepTypeLabel('COMPUTER_CONTROL') === '操作電腦', '10: COMPUTER_CONTROL label');
  }

  // ── 11. projectRunDetail whitelist ──────────────────────────────────────
  {
    const raw = {
      id: 'run-detail-1',
      status: 'SUCCEEDED',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:01:00Z',
      runDir: '/Users/x/MyAgent/dept/slug/runs/run-detail-1',
      input: { prompt: 'secret-input-payload' },
      resumeToken: 'should-never-surface',
      manifest: { engine: 'CLAUDE_CODE' },
      flowJson: { nodes: [] },
      mcp: { servers: ['x'] },
      executionModelFamily: 'claude',
      verificationModelFamily: 'codex',
      output: {
        results: [
          { stepKey: 's1', output: '成果A', ok: true },
          { stepKey: 's2' },
          { bogus: 1 },
        ],
      },
      steps: [
        {
          id: 'rs1',
          runId: 'run-detail-1',
          stepKey: 's1',
          round: 1,
          status: 'approved',
          verdict: 'ok',
          output: 'x',
          error: null,
          approved: true,
          startedAt: 't0',
          endedAt: 't1',
        },
      ],
    };

    const view = projectRunDetail(raw);
    assert(view !== null, '11: view not null');
    assert(view!.id === 'run-detail-1', '11: id');
    assert(view!.status === 'SUCCEEDED', '11: status');
    assert(view!.startedAt === '2026-01-01T00:00:00Z', '11: startedAt');
    assert(view!.finishedAt === '2026-01-01T00:01:00Z', '11: finishedAt');
    assert(view!.steps.length === 1, '11: one step projected');
    assert(view!.steps[0].stepKey === 's1', '11: stepKey');
    assert(view!.steps[0].round === 1, '11: round');
    assert(view!.steps[0].phase === 'approved', '11: RunStep.status → phase');
    assert(view!.steps[0].verdict === 'ok', '11: verdict');
    assert(view!.artifacts.length === 1, '11: only results with non-empty output');
    assert(view!.artifacts[0].stepKey === 's1', '11: artifact s1');
    assert(view!.artifacts[0].content === '成果A', '11: artifact content');

    const bannedKeys = [
      'runDir',
      'input',
      'resumeToken',
      'manifest',
      'flowJson',
      'mcp',
      'executionModelFamily',
      'verificationModelFamily',
    ];
    const viewJson = JSON.stringify(view);
    for (const k of bannedKeys) {
      assert(!viewJson.includes(k), `11: stringify(view) must not contain key name ${k}`);
    }
  }

  // ── 12. projectRunDetail invalid inputs → null, no throw ────────────────
  {
    assert(projectRunDetail(null) === null, '12: null → null');
    assert(projectRunDetail('x') === null, '12: string → null');
    assert(projectRunDetail({}) === null, '12: {} missing id → null');
    assert(projectRunDetail(42) === null, '12: number → null');
    assert(projectRunDetail(undefined) === null, '12: undefined → null');
  }

  // ── 13. visibleWorkbenchControls by role; no full-auto key ──────────────
  {
    const member = visibleWorkbenchControls('MEMBER');
    assert(member.canConfirmSkill === false, '13: MEMBER canConfirmSkill false');
    assert(member.canPropose === true, '13: MEMBER canPropose true');
    assert(member.canDecideApproval === false, '13: MEMBER canDecideApproval false');
    assert(member.canManageRuntime === false, '13: MEMBER canManageRuntime false');
    assert(member.showAdminLink === false, '13: MEMBER showAdminLink false');

    for (const role of ['TRAINER', 'OWNER'] as const) {
      const fde = visibleWorkbenchControls(role);
      assert(fde.canConfirmSkill === true, `13: ${role} canConfirmSkill true`);
      assert(fde.canPropose === true, `13: ${role} canPropose true`);
      assert(fde.canDecideApproval === false, `13: ${role} canDecideApproval false (workbench)`);
      assert(fde.canManageRuntime === false, `13: ${role} canManageRuntime false (workbench)`);
      assert(fde.showAdminLink === true, `13: ${role} showAdminLink true`);
    }

    const anon = visibleWorkbenchControls(undefined);
    assert(anon.canConfirmSkill === false, '13: undefined canConfirmSkill false');
    assert(anon.canPropose === false, '13: undefined canPropose false (not logged in)');
    assert(anon.canDecideApproval === false, '13: undefined canDecideApproval false');
    assert(anon.canManageRuntime === false, '13: undefined canManageRuntime false');
    assert(anon.showAdminLink === false, '13: undefined showAdminLink false');

    const nullRole = visibleWorkbenchControls(null);
    assert(nullRole.canPropose === false, '13: null role canPropose false');

    for (const ctrl of [member, visibleWorkbenchControls('TRAINER'), visibleWorkbenchControls('OWNER'), anon]) {
      for (const key of Object.keys(ctrl)) {
        assert(!/auto/i.test(key), `13: no full-auto expansion key, got ${key}`);
      }
    }
  }

  // ── 14. shouldBindRunStart: only chat:<this conversation> ───────────────
  {
    assert(
      shouldBindRunStart({ runId: 'r1', triggeredBy: 'chat:conv-1' }, 'conv-1') === true,
      '14: matching chat:conv-1 → true',
    );
    assert(
      shouldBindRunStart({ runId: 'r1', triggeredBy: 'chat:conv-2' }, 'conv-1') === false,
      '14: other conversation → false',
    );
    assert(
      shouldBindRunStart({ runId: 'r1', triggeredBy: 'cron:xxx' }, 'conv-1') === false,
      '14: cron trigger → false',
    );
    assert(
      shouldBindRunStart({ runId: 'r1' }, 'conv-1') === false,
      '14: missing triggeredBy → false',
    );
    assert(shouldBindRunStart('x', 'conv-1') === false, '14: non-object payload → false');
    assert(
      shouldBindRunStart({ triggeredBy: 'chat:conv-1' }, 'conv-1') === false,
      '14: missing runId → false',
    );
    assert(
      shouldBindRunStart({ runId: '', triggeredBy: 'chat:conv-1' }, 'conv-1') === false,
      '14: empty runId → false',
    );
    assert(
      shouldBindRunStart({ runId: 'r1', triggeredBy: 'chat:conv-1' }, null) === false,
      '14: null conversation → false',
    );
    assert(
      shouldBindRunStart({ runId: 'r1', triggeredBy: 'chat:conv-1' }, '') === false,
      '14: empty conversation → false',
    );
    assert(
      shouldBindRunStart({ runId: 'r1', triggeredBy: 'chat:conv-1' }, undefined) === false,
      '14: undefined conversation → false',
    );
    // Must not throw on weird input
    assert(shouldBindRunStart(undefined, 'conv-1') === false, '14: undefined payload → false');
    assert(shouldBindRunStart(null, null) === false, '14: null/null → false');
    assert(shouldBindRunStart(42, 'conv-1') === false, '14: number payload → false');
    assert(shouldBindRunStart([], 'conv-1') === false, '14: array payload → false');
  }

  console.log('worksession selftest: ALL PASS');
}

main();
