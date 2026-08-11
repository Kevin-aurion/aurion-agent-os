/**
 * Pure self-test: FDE unified Proposal / Approval review inbox projection
 * (mergeInbox / filterInbox / proposalDiff / classifyApprovalSignal /
 *  canReview / buildDecisionEvidence).
 *
 * Run: npx tsx src/lib/reviewinbox.selftest.ts
 *
 * Round A TDD RED: reviewinbox.ts 尚未存在，本檔預期失敗
 */
import {
  mergeInbox,
  filterInbox,
  proposalDiff,
  classifyApprovalSignal,
  canReview,
  buildDecisionEvidence,
  type ProposalRow,
  type ApprovalRow,
  type ReviewItem,
  type AuditRowLite,
} from './reviewinbox';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function main() {
  // ── 1. mergeInbox: mixed 2 proposal + 1 approval ────────────────────────
  {
    const proposals: ProposalRow[] = [
      {
        id: 'p-old',
        agentId: 'agent-aaaaaaaa',
        runId: null,
        source: 'VIOLATION',
        proposedBy: 'user-member-1',
        targetType: 'RESTRICTION',
        targetId: 'agent-aaaaaaaa',
        proposedChange: { shell: true },
        severity: 'HIGH',
        confidence: 0.9,
        status: 'PENDING',
        createdAt: '2026-01-01T10:00:00.000Z',
        agent: { id: 'agent-aaaaaaaa', name: '會計助理', slug: 'acct' },
      },
      {
        id: 'p-new',
        agentId: 'agent-bbbbbbbb',
        source: 'SEMANTIC',
        proposedBy: 'user-member-2',
        targetType: 'SKILL',
        proposedChange: { contentMd: 'do stuff' },
        severity: 'weird',
        status: 'PENDING',
        createdAt: '2026-01-03T10:00:00.000Z',
        agent: null,
      },
    ];
    const approvals: ApprovalRow[] = [
      {
        id: 'a-mid',
        runId: 'run-1',
        agentId: 'agent-cccccccc',
        reason: '高風險工作流需核准',
        payload: { stepKey: 'x' },
        status: 'PENDING',
        createdAt: '2026-01-02T10:00:00.000Z',
        agent: {
          id: 'agent-cccccccc',
          name: '總經理助理',
          slug: 'ceo',
          riskTier: 'high',
        },
      },
    ];

    const proposalsSnap = deepClone(proposals);
    const approvalsSnap = deepClone(approvals);

    const items = mergeInbox(proposals, approvals);

    assert(items.length === 3, '1: merged length 3');
    assert(
      items[0].createdAt >= items[1].createdAt && items[1].createdAt >= items[2].createdAt,
      '1: createdAt newest → oldest',
    );
    assert(items[0].id === 'p-new', '1: newest is p-new');
    assert(items[1].id === 'a-mid', '1: middle is a-mid');
    assert(items[2].id === 'p-old', '1: oldest is p-old');

    const keys = items.map((i) => i.key);
    assert(new Set(keys).size === keys.length, '1: keys unique');
    assert(items[0].key === 'proposal:p-new', '1: proposal key prefix');
    assert(items[1].key === 'approval:a-mid', '1: approval key prefix');
    assert(items[2].key === 'proposal:p-old', '1: proposal key prefix old');

    assert(items[0].kind === 'proposal', '1: kind proposal');
    assert(items[1].kind === 'run_approval', '1: kind run_approval');
    assert(items[2].kind === 'proposal', '1: kind proposal old');

    assert(items[0].requester === 'user-member-2', '1: proposal requester = proposedBy');
    assert(items[1].requester === 'system', '1: approval requester = system');

    assert(items[0].source === 'SEMANTIC', '1: proposal source from row');
    assert(items[1].source === 'RUN', '1: approval source = RUN');
    assert(items[2].source === 'VIOLATION', '1: proposal source VIOLATION');

    // risk normalization: severity 'weird' → medium; 'HIGH' → high; riskTier 'high' → high
    assert(items[0].risk === 'medium', "1: severity 'weird' → medium");
    assert(items[1].risk === 'high', "1: approval riskTier 'high' → high");
    assert(items[2].risk === 'high', "1: severity 'HIGH' → high");

    assert(items[0].agentName === 'agent-bb', '1: null agent → agentId first 8 chars');
    assert(items[1].agentName === '總經理助理', '1: agentName from agent.name');
    assert(items[2].agentName === '會計助理', '1: agentName from agent.name');

    assert(items[0].summary === 'SKILL', '1: proposal summary = targetType');
    assert(items[1].summary === '高風險工作流需核准', '1: approval summary = reason');
    assert(items[2].summary === 'RESTRICTION', '1: proposal summary RESTRICTION');

    assert(items[0].raw === proposals[1] || items[0].raw.id === 'p-new', '1: raw holds proposal');
    assert(items[1].raw.id === 'a-mid', '1: raw holds approval');

    assert(
      JSON.stringify(proposals) === JSON.stringify(proposalsSnap),
      '1: proposals input immutable (deep)',
    );
    assert(
      JSON.stringify(approvals) === JSON.stringify(approvalsSnap),
      '1: approvals input immutable (deep)',
    );
  }

  // ── 2. filterInbox: kind / risk / source / requester / agentId ──────────
  {
    const items: ReviewItem[] = [
      {
        key: 'proposal:p1',
        kind: 'proposal',
        id: 'p1',
        agentId: 'ag-1',
        agentName: 'A1',
        requester: 'u1',
        risk: 'high',
        source: 'VIOLATION',
        summary: 'RESTRICTION',
        createdAt: '2026-01-03T00:00:00.000Z',
        raw: {} as ProposalRow,
      },
      {
        key: 'approval:a1',
        kind: 'run_approval',
        id: 'a1',
        agentId: 'ag-2',
        agentName: 'A2',
        requester: 'system',
        risk: 'high',
        source: 'RUN',
        summary: 'need review',
        createdAt: '2026-01-02T00:00:00.000Z',
        raw: {} as ApprovalRow,
      },
      {
        key: 'proposal:p2',
        kind: 'proposal',
        id: 'p2',
        agentId: 'ag-1',
        agentName: 'A1',
        requester: 'u2',
        risk: 'low',
        source: 'SEMANTIC',
        summary: 'SKILL',
        createdAt: '2026-01-01T00:00:00.000Z',
        raw: {} as ProposalRow,
      },
    ];
    const snap = deepClone(items);

    const byKind = filterInbox(items, { kind: 'proposal' });
    assert(byKind.length === 2 && byKind.every((i) => i.kind === 'proposal'), '2: kind=proposal');

    const byRisk = filterInbox(items, { risk: 'high' });
    assert(byRisk.length === 2 && byRisk.every((i) => i.risk === 'high'), '2: risk=high');

    const bySource = filterInbox(items, { source: 'RUN' });
    assert(bySource.length === 1 && bySource[0].id === 'a1', '2: source=RUN');

    const byRequester = filterInbox(items, { requester: 'system' });
    assert(byRequester.length === 1 && byRequester[0].id === 'a1', '2: requester=system');

    const byAgent = filterInbox(items, { agentId: 'ag-1' });
    assert(byAgent.length === 2 && byAgent.every((i) => i.agentId === 'ag-1'), '2: agentId=ag-1');

    const allPass = filterInbox(items, {
      kind: 'all',
      risk: 'all',
      source: 'all',
      requester: 'all',
      agentId: 'all',
    });
    assert(allPass.length === 3, "2: all 'all' → no filter");

    const undefPass = filterInbox(items, {});
    assert(undefPass.length === 3, '2: empty filter → no filter');

    const combo = filterInbox(items, { kind: 'proposal', risk: 'high' });
    assert(combo.length === 1 && combo[0].id === 'p1', '2: kind+risk combo');

    assert(JSON.stringify(items) === JSON.stringify(snap), '2: input immutable');
  }

  // ── 3. proposalDiff RESTRICTION ─────────────────────────────────────────
  {
    const current = { shell: false, webSearch: true };
    const patch = { shell: true, note: 'x' };
    const rows = proposalDiff('RESTRICTION', patch, current);

    // keys = union of current + patch, alphabetical: note, shell, webSearch
    assert(rows.length === 3, '3: three rows for union keys');
    assert(
      rows.map((r) => r.key).join(',') === 'note,shell,webSearch',
      '3: keys alphabetical stable',
    );

    const shell = rows.find((r) => r.key === 'shell')!;
    assert(shell.before === 'false' || shell.before === JSON.stringify(false), '3: shell before false');
    // contract: before = JSON.stringify(current[key]) → "false"; after = merge → "true"
    assert(shell.before === JSON.stringify(false), '3: shell before JSON.stringify(false)');
    assert(shell.after === JSON.stringify(true), '3: shell after JSON.stringify(true)');
    assert(shell.changed === true, '3: shell changed');

    const web = rows.find((r) => r.key === 'webSearch')!;
    assert(web.before === JSON.stringify(true), '3: webSearch before true');
    assert(web.after === JSON.stringify(true), '3: webSearch after still true');
    assert(web.changed === false, '3: webSearch unchanged');

    const note = rows.find((r) => r.key === 'note')!;
    assert(note.before === null, '3: note before null (missing in current)');
    assert(note.after === JSON.stringify('x'), '3: note after "x"');
    assert(note.changed === true, '3: note changed');
  }

  // ── 4. proposalDiff SKILL / string / null ───────────────────────────────
  {
    // object proposedChange → one row per key
    const objRows = proposalDiff('SKILL', { contentMd: 'hello skill body' });
    assert(objRows.length === 1, '4: object → one row per key');
    assert(objRows[0].key === 'contentMd', '4: key contentMd');
    assert(objRows[0].before === null, '4: before null for non-RESTRICTION object');
    assert(objRows[0].after === JSON.stringify('hello skill body'), '4: after stringify');
    assert(objRows[0].changed === true, '4: changed true');

    // multi-key object
    const multi = proposalDiff('IDENTITY', { name: 'x', role: 'y' });
    assert(multi.length === 2, '4: multi-key object → 2 rows');
    assert(multi.every((r) => r.before === null && r.changed === true), '4: multi before null changed');

    // pure string → single 'content' row, first 500 chars
    const long = 'a'.repeat(600);
    const strRows = proposalDiff('SKILL', long);
    assert(strRows.length === 1, '4: string → single row');
    assert(strRows[0].key === 'content', "4: string key 'content'");
    assert(strRows[0].before === null, '4: string before null');
    assert(strRows[0].after === long.slice(0, 500), '4: string after first 500 chars');
    assert(strRows[0].changed === true, '4: string changed');

    // null → single 'change' row
    const nullRows = proposalDiff('SKILL', null);
    assert(nullRows.length === 1, '4: null → single row');
    assert(nullRows[0].key === 'change', "4: null key 'change'");
    assert(nullRows[0].before === null, '4: null before null');
    assert(nullRows[0].after === JSON.stringify(null), '4: null after JSON.stringify(null)');
    assert(nullRows[0].changed === true, '4: null changed');
  }

  // ── 5. classifyApprovalSignal (fail-closed / negative security) ─────────
  {
    assert(
      classifyApprovalSignal({ origin: 'aios', topic: 'approval.request' }) === 'aios-approval',
      '5: aios + approval.request → aios-approval',
    );
    assert(
      classifyApprovalSignal({ origin: 'langflow', topic: 'approval.request' }) === 'informational',
      '5: langflow origin → informational',
    );
    assert(
      classifyApprovalSignal({ origin: 'aios', topic: 'runtime.checkpoint' }) === 'informational',
      '5: runtime.checkpoint → informational',
    );
    assert(
      classifyApprovalSignal({
        origin: 'langflow',
        topic: 'checkpoint.approved',
        payload: { approved: true },
      }) === 'informational',
      '5: langflow checkpoint + payload.approved → informational (NOT aios-approval)',
    );
    assert(classifyApprovalSignal({}) === 'informational', '5: empty → informational');
    assert(
      classifyApprovalSignal({ topic: 'approval.request' }) === 'informational',
      '5: topic only (no origin) → informational',
    );
    // extra fail-closed: origin alone, wrong topic with aios, runtime/checkpoint noise
    assert(
      classifyApprovalSignal({ origin: 'aios' }) === 'informational',
      '5: origin aios only → informational',
    );
    assert(
      classifyApprovalSignal({ origin: 'runtime', topic: 'approval.request' }) === 'informational',
      '5: origin runtime → informational',
    );
  }

  // ── 6. canReview (fail-closed role gate) ────────────────────────────────
  {
    assert(canReview('OWNER') === true, '6: OWNER true');
    assert(canReview('TRAINER') === true, '6: TRAINER true');
    assert(canReview('MEMBER') === false, '6: MEMBER false');
    assert(canReview('owner') === false, '6: lowercase owner false');
    assert(canReview('') === false, '6: empty string false');
    assert(canReview(null) === false, '6: null false');
    assert(canReview(undefined) === false, '6: undefined false');
  }

  // ── 7. buildDecisionEvidence ────────────────────────────────────────────
  {
    // 7a. proposal reject with matching audit
    {
      const targetId = 'prop-rej-1';
      const auditRows: AuditRowLite[] = [
        {
          id: 'aud-1',
          action: 'proposal.rejected',
          entity: 'ChangeProposal',
          entityId: targetId,
          hash: 'h2',
          prevHash: 'h1',
          createdAt: '2026-01-01T12:00:00.000Z',
        },
      ];
      const ev = buildDecisionEvidence({
        kind: 'proposal',
        decision: 'reject',
        targetId,
        response: { id: targetId, status: 'REJECTED', resultingVersionId: null },
        auditRows,
      });
      assert(ev.decidedStatus === 'REJECTED', '7a: decidedStatus REJECTED');
      assert(ev.zeroChange === true, '7a: zeroChange true on reject without version');
      assert(ev.resultingVersionId === null, '7a: resultingVersionId null');
      assert(ev.auditAction === 'proposal.rejected', '7a: auditAction');
      assert(ev.auditHash === 'h2', '7a: auditHash h2');
      assert(ev.auditPrevHash === 'h1', '7a: auditPrevHash h1');
      assert(ev.chainLinked === true, '7a: chainLinked true when hash present');
    }

    // 7b. proposal approve with resultingVersionId
    {
      const ev = buildDecisionEvidence({
        kind: 'proposal',
        decision: 'approve',
        targetId: 'prop-ok-1',
        response: { proposal: { status: 'APPROVED' }, resultingVersionId: 'v1' },
        auditRows: [],
      });
      assert(ev.decidedStatus === 'APPROVED', '7b: decidedStatus from response.proposal.status');
      assert(ev.zeroChange === false, '7b: approve → zeroChange false');
      assert(ev.resultingVersionId === 'v1', '7b: resultingVersionId v1');
    }

    // 7c. approval reject → CANCELLED, zeroChange true
    {
      const targetId = 'appr-rej-1';
      const auditRows: AuditRowLite[] = [
        {
          id: 'aud-a1',
          action: 'approval.rejected',
          entity: 'ApprovalRequest',
          entityId: targetId,
          hash: 'ah2',
          prevHash: 'ah1',
          createdAt: '2026-01-02T12:00:00.000Z',
        },
      ];
      const ev = buildDecisionEvidence({
        kind: 'run_approval',
        decision: 'reject',
        targetId,
        response: { approvalId: targetId, runId: 'run-x', status: 'CANCELLED' },
        auditRows,
      });
      assert(ev.decidedStatus === 'CANCELLED', '7c: decidedStatus CANCELLED');
      assert(ev.zeroChange === true, '7c: zeroChange true');
      assert(ev.auditAction === 'approval.rejected', '7c: auditAction approval.rejected');
      assert(ev.chainLinked === true, '7c: chainLinked true');
    }

    // 7d. audit no match (entityId different)
    {
      const ev = buildDecisionEvidence({
        kind: 'proposal',
        decision: 'reject',
        targetId: 'prop-nomatch',
        response: { status: 'REJECTED', resultingVersionId: null },
        auditRows: [
          {
            id: 'aud-x',
            action: 'proposal.rejected',
            entity: 'ChangeProposal',
            entityId: 'other-id',
            hash: 'hx',
            prevHash: 'hy',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      assert(ev.auditAction === null, '7d: auditAction null when no match');
      assert(ev.auditHash === null, '7d: auditHash null');
      assert(ev.auditPrevHash === null, '7d: auditPrevHash null');
      assert(ev.chainLinked === false, '7d: chainLinked false');
    }

    // 7e. audit match but hash null → chainLinked false
    {
      const targetId = 'prop-nohash';
      const ev = buildDecisionEvidence({
        kind: 'proposal',
        decision: 'approve',
        targetId,
        response: { proposal: { status: 'APPROVED' }, resultingVersionId: 'v2' },
        auditRows: [
          {
            id: 'aud-nh',
            action: 'proposal.approved',
            entity: 'ChangeProposal',
            entityId: targetId,
            hash: null,
            prevHash: null,
            createdAt: '2026-01-05T00:00:00.000Z',
          },
        ],
      });
      assert(ev.auditAction === 'proposal.approved', '7e: audit matched');
      assert(ev.auditHash === null, '7e: hash null');
      assert(ev.chainLinked === false, '7e: chainLinked false when hash null');
    }

    // 7f. decidedStatus fallback UNKNOWN when response empty
    {
      const ev = buildDecisionEvidence({
        kind: 'proposal',
        decision: 'approve',
        targetId: 'x',
        response: {},
        auditRows: [],
      });
      assert(ev.decidedStatus === 'UNKNOWN', '7f: empty response → UNKNOWN');
    }

    // 7g. newest audit row wins when multiple match
    {
      const targetId = 'prop-multi';
      const ev = buildDecisionEvidence({
        kind: 'proposal',
        decision: 'reject',
        targetId,
        response: { status: 'REJECTED' },
        auditRows: [
          {
            id: 'old',
            action: 'proposal.rejected',
            entity: 'ChangeProposal',
            entityId: targetId,
            hash: 'old-h',
            prevHash: 'old-p',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'new',
            action: 'proposal.rejected',
            entity: 'ChangeProposal',
            entityId: targetId,
            hash: 'new-h',
            prevHash: 'new-p',
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      });
      assert(ev.auditHash === 'new-h', '7g: newest audit by createdAt');
      assert(ev.auditPrevHash === 'new-p', '7g: newest prevHash');
    }
  }

  console.log('reviewinbox selftest: ALL PASS');
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
