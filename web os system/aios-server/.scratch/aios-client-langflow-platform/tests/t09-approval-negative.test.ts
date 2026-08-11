/**
 * Ticket 09 — approval-gated-action-v1 (negative / fail-closed).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t09-approval-negative.test.ts
 *
 * Every case: observe real REJECTED/throw + zero FlowArtifact count delta.
 * Zero new deps. Real DB via prisma singleton. No git.
 */
import { prisma } from '../../../src/lib/db.js';
import { assertGraphSafe } from '../../../src/compiler/registry.js';
import { compileAndStore, compileSkillIr } from '../../../src/compiler/compile.js';

let failed = 0;
let passed = 0;

function pass(label: string, detail = ''): void {
  passed += 1;
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  process.exitCode = 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

function check(cond: unknown, label: string, detailOnFail: string): void {
  if (cond) pass(label);
  else fail(label, detailOnFail);
}

function baseSlots(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approval: {
      reason: '需 FDE 核准',
      risk: 'high' as const,
    },
    taskDescription: '核准後執行單一寫入動作',
    readTools: ['mcp:gmail:gmail_list_messages'],
    writeTool: 'mcp:gmail:gmail_send_reply',
    ...overrides,
  };
}

function baseIr(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'aios.skill-ir/1' as const,
    template: 'approval-gated-action-v1',
    name: 't09-neg',
    slots: baseSlots(),
    ...overrides,
  };
}

async function withCountInvariant(
  label: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  const before = await prisma.flowArtifact.count();
  try {
    await fn();
  } finally {
    const after = await prisma.flowArtifact.count();
    check(
      after === before,
      `${label}: flowArtifact.count unchanged`,
      `before=${before} after=${after}`,
    );
  }
}

function throwsAssertGraphSafe(graph: unknown): { threw: boolean; message: string } {
  try {
    assertGraphSafe(graph);
    return { threw: false, message: '' };
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) };
  }
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Build a valid positive graph via compile (when template exists), else minimal stub for tamper tests. */
function getPositiveGraph(): Record<string, unknown> | null {
  const r = compileSkillIr(baseIr());
  if (!r.ok) return null;
  return deepClone(r.artifactJson) as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log('── [1] dual write IR layer: unknown writeTools / missing writeTool ──');
  await withCountInvariant('dual-write-ir', async () => {
    const extra = baseIr({
      slots: {
        ...baseSlots(),
        writeTools: ['mcp:gmail:gmail_send_reply', 'mcp:drive:drive_upload_file'],
      },
    });
    const r1 = compileSkillIr(extra);
    check(r1.ok === false, 'unknown key writeTools → not ok', JSON.stringify(r1));
    if (!r1.ok) {
      check(r1.status === 'REJECTED', 'writeTools REJECTED', r1.status);
    }

    const { writeTool: _drop, ...noWrite } = baseSlots() as Record<string, unknown> & {
      writeTool?: string;
    };
    void _drop;
    const missing = baseIr({ slots: noWrite });
    const r2 = compileSkillIr(missing);
    check(r2.ok === false, 'missing writeTool → not ok', JSON.stringify(r2));
    if (!r2.ok) {
      check(r2.status === 'REJECTED', 'missing writeTool REJECTED', r2.status);
    }
  });

  console.log('\n── [2] dual write graph layer: second tool.gated → throw ──');
  await withCountInvariant('dual-write-graph', () => {
    const graph = getPositiveGraph();
    if (!graph) {
      // Template not registered yet — still exercise assertGraphSafe with handcrafted dual write
      const handcrafted = {
        schemaVersion: 'aios.flow-graph/1',
        template: 'approval-gated-action-v1',
        templateVersion: '1',
        nodes: [
          { id: 'n_input', kind: 'input', config: {} },
          {
            id: 'n_checkpoint',
            kind: 'approval.checkpoint',
            config: {
              reason: 'x',
              risk: 'high',
              authority: 'AIOS',
              emits: 'approval.required',
              resumeRequires: 'aios.approvalRequest.APPROVED',
            },
          },
          { id: 'n_action', kind: 'tool.gated', tool: 'mcp:gmail:gmail_send_reply', config: {} },
          {
            id: 'n_action2',
            kind: 'tool.gated',
            tool: 'mcp:drive:drive_create_file',
            config: {},
          },
          { id: 'n_output', kind: 'output', config: {} },
        ],
        edges: [
          { from: 'n_input', to: 'n_checkpoint' },
          { from: 'n_checkpoint', to: 'n_action' },
          { from: 'n_action', to: 'n_action2' },
          { from: 'n_action2', to: 'n_output' },
        ],
      };
      const { threw, message } = throwsAssertGraphSafe(handcrafted);
      check(threw, 'handcrafted dual tool.gated throws', 'did not throw');
      if (threw) pass('dual write message', message);
      return;
    }

    const nodes = graph.nodes as Array<Record<string, unknown>>;
    const edges = graph.edges as Array<{ from: string; to: string }>;
    nodes.push({
      id: 'n_action_extra',
      kind: 'tool.gated',
      tool: 'mcp:drive:drive_create_file',
      config: {},
    });
    // splice edge before output if present
    const outIdx = edges.findIndex((e) => e.to === 'n_output' || e.to.includes('output'));
    if (outIdx >= 0) {
      const e = edges[outIdx]!;
      edges.splice(outIdx, 1, { from: e.from, to: 'n_action_extra' }, {
        from: 'n_action_extra',
        to: e.to,
      });
    } else {
      edges.push({ from: 'n_action', to: 'n_action_extra' });
    }
    const { threw, message } = throwsAssertGraphSafe(graph);
    check(threw, 'second tool.gated throws', 'did not throw');
    if (threw) pass('second gated message', message);
  });

  console.log('\n── [3] write-before-checkpoint ──');
  await withCountInvariant('write-before-checkpoint', () => {
    const base = getPositiveGraph();
    const makeBase = (): Record<string, unknown> => {
      if (base) return deepClone(base);
      return {
        schemaVersion: 'aios.flow-graph/1',
        template: 'approval-gated-action-v1',
        templateVersion: '1',
        nodes: [
          { id: 'n_input', kind: 'input', config: {} },
          {
            id: 'n_checkpoint',
            kind: 'approval.checkpoint',
            config: {
              reason: 'x',
              risk: 'high',
              authority: 'AIOS',
              emits: 'approval.required',
              resumeRequires: 'aios.approvalRequest.APPROVED',
            },
          },
          { id: 'n_action', kind: 'tool.gated', tool: 'mcp:gmail:gmail_send_reply', config: {} },
          { id: 'n_verify', kind: 'gateway.verify', config: {} },
          { id: 'n_output', kind: 'output', config: {} },
        ],
        edges: [
          { from: 'n_input', to: 'n_checkpoint' },
          { from: 'n_checkpoint', to: 'n_action' },
          { from: 'n_action', to: 'n_verify' },
          { from: 'n_verify', to: 'n_output' },
        ],
      };
    };

    // (a) remove checkpoint node
    const gA = makeBase();
    gA.nodes = (gA.nodes as Array<Record<string, unknown>>).filter(
      (n) => n.kind !== 'approval.checkpoint',
    );
    gA.edges = (gA.edges as Array<{ from: string; to: string }>).filter(
      (e) => e.from !== 'n_checkpoint' && e.to !== 'n_checkpoint',
    );
    // reconnect input → action if needed
    const edgesA = gA.edges as Array<{ from: string; to: string }>;
    if (!edgesA.some((e) => e.from === 'n_input')) {
      edgesA.push({ from: 'n_input', to: 'n_action' });
    }
    const rA = throwsAssertGraphSafe(gA);
    check(rA.threw, 'no checkpoint ancestor throws', 'did not throw');

    // (b) reverse checkpoint/action edges so gated comes first
    const gB = makeBase();
    const edgesB = gB.edges as Array<{ from: string; to: string }>;
    for (let i = 0; i < edgesB.length; i++) {
      const e = edgesB[i]!;
      if (e.from === 'n_checkpoint' && e.to === 'n_action') {
        edgesB[i] = { from: 'n_action', to: 'n_checkpoint' };
      } else if (e.from === 'n_input' && e.to === 'n_checkpoint') {
        edgesB[i] = { from: 'n_input', to: 'n_action' };
      } else if (e.from === 'n_action' && (e.to === 'n_verify' || e.to === 'n_output')) {
        // after reverse, checkpoint should feed verify: action → checkpoint → verify
        edgesB[i] = { from: 'n_checkpoint', to: e.to };
      }
    }
    const rB = throwsAssertGraphSafe(gB);
    check(rB.threw, 'checkpoint after gated throws', 'did not throw');
  });

  console.log('\n── [4] self-approval ──');
  await withCountInvariant('self-approval', async () => {
    const makeBase = (): Record<string, unknown> | null => {
      const g = getPositiveGraph();
      if (g) return g;
      return {
        schemaVersion: 'aios.flow-graph/1',
        template: 'approval-gated-action-v1',
        templateVersion: '1',
        nodes: [
          { id: 'n_input', kind: 'input', config: {} },
          {
            id: 'n_checkpoint',
            kind: 'approval.checkpoint',
            config: {
              reason: 'x',
              risk: 'high',
              authority: 'AIOS',
              emits: 'approval.required',
              resumeRequires: 'aios.approvalRequest.APPROVED',
            },
          },
          { id: 'n_action', kind: 'tool.gated', tool: 'mcp:gmail:gmail_send_reply', config: {} },
          { id: 'n_output', kind: 'output', config: {} },
        ],
        edges: [
          { from: 'n_input', to: 'n_checkpoint' },
          { from: 'n_checkpoint', to: 'n_action' },
          { from: 'n_action', to: 'n_output' },
        ],
      };
    };

    // (a) authority = LANGFLOW
    const gA = makeBase();
    if (gA) {
      const nodes = gA.nodes as Array<Record<string, unknown>>;
      const cp = nodes.find((n) => n.kind === 'approval.checkpoint');
      if (cp && cp.config && typeof cp.config === 'object') {
        (cp.config as Record<string, unknown>).authority = 'LANGFLOW';
      }
      const r = throwsAssertGraphSafe(gA);
      check(r.threw, "authority=LANGFLOW throws", 'did not throw');
    } else {
      fail("authority=LANGFLOW throws", 'could not build graph');
    }

    // (b) autoApprove: true
    const gB = makeBase();
    if (gB) {
      const nodes = gB.nodes as Array<Record<string, unknown>>;
      const cp = nodes.find((n) => n.kind === 'approval.checkpoint');
      if (cp && cp.config && typeof cp.config === 'object') {
        (cp.config as Record<string, unknown>).autoApprove = true;
      }
      const r = throwsAssertGraphSafe(gB);
      check(r.threw, 'autoApprove key throws', 'did not throw');
    } else {
      fail('autoApprove key throws', 'could not build graph');
    }

    // (c) IR layer unknown key autoApprove on approval
    const ir = baseIr({
      slots: baseSlots({
        approval: {
          reason: '需 FDE 核准',
          risk: 'high',
          autoApprove: true,
        },
      }),
    });
    const rIr = compileSkillIr(ir);
    check(rIr.ok === false, 'approval.autoApprove IR → not ok', JSON.stringify(rIr));
    if (!rIr.ok) {
      check(rIr.status === 'REJECTED', 'approval.autoApprove REJECTED', rIr.status);
    }
  });

  console.log('\n── [5] governance/publish/permission write tools ──');
  await withCountInvariant('gov-write-tools', async () => {
    const banned = [
      'mcp:aios:skill_confirm',
      'mcp:aios:publish_flow',
      'mcp:msgraph:permission_grant',
    ];
    for (const writeTool of banned) {
      const ir = baseIr({ slots: baseSlots({ writeTool }) });
      const r = compileSkillIr(ir);
      check(r.ok === false, `writeTool=${writeTool} compile not ok`, JSON.stringify(r));
      if (!r.ok) {
        check(r.status === 'REJECTED', `writeTool=${writeTool} REJECTED`, r.status);
      }
      const stored = await compileAndStore(ir, { createdBy: 't09-neg' });
      check(
        stored.ok === false,
        `writeTool=${writeTool} compileAndStore not ok`,
        JSON.stringify(stored),
      );
      if (!stored.ok) {
        check(
          stored.status === 'REJECTED',
          `writeTool=${writeTool} store REJECTED`,
          stored.status,
        );
      }
    }
  });

  console.log('\n── [6] edges missing fail-closed ──');
  await withCountInvariant('edges-missing', () => {
    const makeWithEdges = (edges: unknown): Record<string, unknown> => {
      const g = getPositiveGraph();
      if (g) {
        if (edges === undefined) {
          delete g.edges;
        } else {
          g.edges = edges as never;
        }
        return g;
      }
      const nodes = [
        { id: 'n_input', kind: 'input', config: {} },
        {
          id: 'n_checkpoint',
          kind: 'approval.checkpoint',
          config: {
            reason: 'x',
            risk: 'high',
            authority: 'AIOS',
            emits: 'approval.required',
            resumeRequires: 'aios.approvalRequest.APPROVED',
          },
        },
        { id: 'n_action', kind: 'tool.gated', tool: 'mcp:gmail:gmail_send_reply', config: {} },
        { id: 'n_output', kind: 'output', config: {} },
      ];
      const out: Record<string, unknown> = {
        schemaVersion: 'aios.flow-graph/1',
        template: 'approval-gated-action-v1',
        templateVersion: '1',
        nodes,
      };
      if (edges !== undefined) out.edges = edges;
      return out;
    };

    const r1 = throwsAssertGraphSafe(makeWithEdges(undefined));
    check(r1.threw, 'edges=undefined throws', 'did not throw');

    const r2 = throwsAssertGraphSafe(makeWithEdges({ not: 'array' }));
    check(r2.threw, 'edges=non-array throws', 'did not throw');
  });

  console.log('\n── [7] risk=low → strict enum REJECTED ──');
  await withCountInvariant('risk-low', async () => {
    const ir = baseIr({
      slots: baseSlots({
        approval: {
          reason: '不應允許 low',
          risk: 'low',
        },
      }),
    });
    const r = compileSkillIr(ir);
    check(r.ok === false, 'risk=low → not ok', JSON.stringify(r));
    if (!r.ok) {
      check(r.status === 'REJECTED', 'risk=low REJECTED', r.status);
    }
  });

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('FATAL', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
