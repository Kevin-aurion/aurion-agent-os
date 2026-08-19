/**
 * T01 — GraphSpec v2 schema, fail-closed validator, v1→v2 upgrade.
 * Run: npx tsx .scratch/graph-engineering/tests/t01-schema-validate-upgrade.test.ts
 */
import { buildEmailTriageReadonlyV1Graph } from '../../../src/compiler/templates/email-triage-readonly-v1.js';
import { buildApprovalGatedActionV1Graph } from '../../../src/compiler/templates/approval-gated-action-v1.js';
import { upgradeFlowGraphV1ToV2 } from '../../../src/graph/upgrade.js';
import { validateGraph } from '../../../src/graph/validate.js';
import {
  approvalGatedGraph,
  check,
  echoGraph,
  fail,
  linearIoGraph,
  pass,
  resetCounters,
  summary,
} from './helpers.js';

function hasCode(issues: Array<{ code: string }>, code: string): boolean {
  return issues.some((i) => i.code === code);
}

async function main(): Promise<void> {
  resetCounters();
  console.log('── t01-schema-validate-upgrade ──');

  // ── Happy paths ──────────────────────────────────────────────────────────
  {
    const v = validateGraph(echoGraph());
    check(v.ok === true, 'echo graph validates', JSON.stringify(v));
  }
  {
    const v = validateGraph(linearIoGraph());
    check(v.ok === true, 'input→output validates', JSON.stringify(v));
  }
  {
    const v = validateGraph(approvalGatedGraph());
    check(v.ok === true, 'approval-gated tool validates', JSON.stringify(v));
  }

  // ── Schema / unknown fields ──────────────────────────────────────────────
  {
    const g = echoGraph() as unknown as Record<string, unknown>;
    g.extraField = true;
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'SCHEMA_INVALID'), 'unknown top-level field rejected', '');
  }
  {
    const v = validateGraph({ schemaVersion: 'aios.flow-graph/2' });
    check(v.ok === false, 'incomplete graph rejected', '');
  }
  {
    const g = echoGraph();
    (g.nodes[0] as { kind: string }).kind = 'python.custom' as never;
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'SCHEMA_INVALID'), 'unknown node kind rejected', '');
  }

  // ── Duplicate ids ────────────────────────────────────────────────────────
  {
    const g = echoGraph();
    g.nodes = [
      ...g.nodes,
      { id: 'n_start', kind: 'output', label: 'dup', position: { x: 0, y: 0 }, config: {} },
    ];
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'DUPLICATE_NODE_ID'), 'duplicate node id', '');
  }
  {
    const g = echoGraph();
    g.edges = [
      ...g.edges,
      { id: 'e_start_end', kind: 'default', source: 'n_start', target: 'n_end' },
    ];
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'DUPLICATE_EDGE_ID'), 'duplicate edge id', '');
  }

  // ── Missing endpoints / entry / exit ─────────────────────────────────────
  {
    const g = echoGraph();
    g.edges = [{ id: 'e_bad', kind: 'default', source: 'n_start', target: 'missing' }];
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'MISSING_ENDPOINT'), 'missing edge target', '');
  }
  {
    const g = echoGraph();
    g.entryNodeId = 'nope';
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'MISSING_ENTRY'), 'missing entry', '');
  }
  {
    const g = echoGraph();
    g.exitNodeIds = ['nope'];
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'MISSING_EXIT'), 'missing exit', '');
  }

  // ── Reachability ─────────────────────────────────────────────────────────
  {
    const g = echoGraph();
    g.nodes.push({
      id: 'orphan',
      kind: 'output',
      label: 'orphan',
      position: { x: 0, y: 50 },
      config: {},
    });
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'UNREACHABLE_NODE'), 'orphan unreachable', '');
  }

  // ── No path to terminal ──────────────────────────────────────────────────
  {
    const g: ReturnType<typeof echoGraph> = {
      schemaVersion: 'aios.flow-graph/2',
      id: 'g_dead',
      name: 'dead',
      revision: 1,
      stateSchema: { type: 'object' },
      entryNodeId: 'a',
      exitNodeIds: ['c'],
      nodes: [
        { id: 'a', kind: 'input', label: 'a', position: { x: 0, y: 0 }, config: {} },
        { id: 'b', kind: 'gateway.summarize', label: 'b', position: { x: 100, y: 0 }, config: {} },
        { id: 'c', kind: 'output', label: 'c', position: { x: 200, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', kind: 'default', source: 'a', target: 'b' },
        // c is exit but nothing points to it; b cannot reach terminal
      ],
    };
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'NO_PATH_TO_TERMINAL'), 'no path to terminal', '');
  }

  // ── Unbounded cycle ──────────────────────────────────────────────────────
  {
    const g: ReturnType<typeof echoGraph> = {
      schemaVersion: 'aios.flow-graph/2',
      id: 'g_cycle',
      name: 'cycle',
      revision: 1,
      stateSchema: { type: 'object' },
      entryNodeId: 'a',
      exitNodeIds: ['c'],
      nodes: [
        { id: 'a', kind: 'input', label: 'a', position: { x: 0, y: 0 }, config: {} },
        { id: 'b', kind: 'gateway.summarize', label: 'b', position: { x: 100, y: 0 }, config: {} },
        { id: 'c', kind: 'output', label: 'c', position: { x: 200, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', kind: 'default', source: 'a', target: 'b' },
        { id: 'e2', kind: 'default', source: 'b', target: 'c' },
        { id: 'e3', kind: 'default', source: 'c', target: 'b' }, // cycle without loop edge
      ],
    };
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'UNBOUNDED_CYCLE'), 'cycle without loop edge', '');
  }

  // ── Bounded loop OK ──────────────────────────────────────────────────────
  {
    const g: ReturnType<typeof echoGraph> = {
      schemaVersion: 'aios.flow-graph/2',
      id: 'g_loop',
      name: 'loop',
      revision: 1,
      stateSchema: { type: 'object' },
      entryNodeId: 'a',
      exitNodeIds: ['c'],
      nodes: [
        { id: 'a', kind: 'input', label: 'a', position: { x: 0, y: 0 }, config: {} },
        { id: 'b', kind: 'control.loop', label: 'loop', position: { x: 100, y: 0 }, config: {} },
        { id: 'c', kind: 'output', label: 'c', position: { x: 200, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', kind: 'default', source: 'a', target: 'b' },
        { id: 'e2', kind: 'default', source: 'b', target: 'c' },
        { id: 'e3', kind: 'loop', source: 'b', target: 'a', maxTraversals: 3 },
      ],
    };
    const v = validateGraph(g);
    check(v.ok === true, 'bounded loop with loop edge ok', JSON.stringify(v));
  }

  // ── Condition / parallel / join ──────────────────────────────────────────
  {
    const g: ReturnType<typeof echoGraph> = {
      schemaVersion: 'aios.flow-graph/2',
      id: 'g_cond_bad',
      name: 'cond',
      revision: 1,
      stateSchema: { type: 'object' },
      entryNodeId: 'a',
      exitNodeIds: ['c', 'd'],
      nodes: [
        { id: 'a', kind: 'input', label: 'a', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'b',
          kind: 'control.condition',
          label: 'if',
          position: { x: 100, y: 0 },
          config: { operator: 'equals', matchText: 'x' },
        },
        { id: 'c', kind: 'output', label: 'c', position: { x: 200, y: 0 }, config: {} },
        { id: 'd', kind: 'output', label: 'd', position: { x: 200, y: 80 }, config: {} },
      ],
      edges: [
        { id: 'e1', kind: 'default', source: 'a', target: 'b' },
        {
          id: 'e2',
          kind: 'condition',
          source: 'b',
          target: 'c',
          condition: { branch: 'true' },
        },
        // missing false branch
      ],
    };
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'INVALID_CONDITION_FANOUT'), 'condition fan-out', '');
  }
  {
    const g: ReturnType<typeof echoGraph> = {
      schemaVersion: 'aios.flow-graph/2',
      id: 'g_par',
      name: 'par',
      revision: 1,
      stateSchema: { type: 'object' },
      entryNodeId: 'a',
      exitNodeIds: ['d'],
      nodes: [
        { id: 'a', kind: 'input', label: 'a', position: { x: 0, y: 0 }, config: {} },
        { id: 'p', kind: 'control.parallel', label: 'p', position: { x: 100, y: 0 }, config: {} },
        { id: 'b', kind: 'gateway.summarize', label: 'b', position: { x: 200, y: 0 }, config: {} },
        { id: 'd', kind: 'output', label: 'd', position: { x: 300, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', kind: 'default', source: 'a', target: 'p' },
        { id: 'e2', kind: 'parallel', source: 'p', target: 'b' },
        { id: 'e3', kind: 'default', source: 'b', target: 'd' },
      ],
    };
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'INVALID_PARALLEL'), 'parallel needs 2 branches', '');
  }
  {
    const g: ReturnType<typeof echoGraph> = {
      schemaVersion: 'aios.flow-graph/2',
      id: 'g_join',
      name: 'join',
      revision: 1,
      stateSchema: { type: 'object' },
      entryNodeId: 'a',
      exitNodeIds: ['d'],
      nodes: [
        { id: 'a', kind: 'input', label: 'a', position: { x: 0, y: 0 }, config: {} },
        { id: 'j', kind: 'control.join', label: 'j', position: { x: 100, y: 0 }, config: {} },
        { id: 'd', kind: 'output', label: 'd', position: { x: 200, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', kind: 'default', source: 'a', target: 'j' },
        { id: 'e2', kind: 'default', source: 'j', target: 'd' },
      ],
    };
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'INVALID_JOIN'), 'join needs 2 inputs', '');
  }

  // ── tool.gated without approval ──────────────────────────────────────────
  {
    const g = approvalGatedGraph();
    g.nodes = g.nodes.filter((n) => n.kind !== 'approval.checkpoint');
    g.edges = [
      { id: 'e1', kind: 'default', source: 'n_in', target: 'n_gate' },
      { id: 'e2', kind: 'default', source: 'n_gate', target: 'n_out' },
    ];
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'GATED_WITHOUT_APPROVAL'), 'gated without approval', '');
  }

  // ── Bypass path around approval ──────────────────────────────────────────
  {
    const g = approvalGatedGraph();
    // Add side path entry → gated that skips checkpoint
    g.edges.push({ id: 'e_bypass', kind: 'default', source: 'n_in', target: 'n_gate' });
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'GATED_WITHOUT_APPROVAL'), 'gated with unprotected path', '');
  }

  // ── Subgraph ref ─────────────────────────────────────────────────────────
  {
    const g = echoGraph();
    g.nodes = [
      g.nodes[0]!,
      {
        id: 'n_sub',
        kind: 'subgraph',
        label: 'sub',
        position: { x: 200, y: 100 },
        config: { artifactId: 'x' }, // missing digest
      },
      g.nodes[1]!,
    ];
    g.edges = [
      { id: 'e1', kind: 'default', source: 'n_start', target: 'n_sub' },
      { id: 'e2', kind: 'default', source: 'n_sub', target: 'n_end' },
    ];
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'INVALID_SUBGRAPH_REF'), 'subgraph missing digest', '');
  }

  // ── Secret / provider material ───────────────────────────────────────────
  {
    const g = echoGraph();
    g.nodes[0]!.config = { apiKey: 'sk-test-should-fail-abcdef012345' };
    const v = validateGraph(g);
    check(
      v.ok === false && hasCode(v.issues, 'SECRET_OR_PROVIDER_MATERIAL'),
      'apiKey config rejected',
      '',
    );
  }
  {
    const g = echoGraph();
    g.nodes[0]!.config = { note: 'call api.openai.com please' };
    const v = validateGraph(g);
    check(
      v.ok === false && hasCode(v.issues, 'SECRET_OR_PROVIDER_MATERIAL'),
      'provider marker rejected',
      '',
    );
  }
  {
    // gmail.com in ordinary business text must NOT false-positive
    const g = echoGraph();
    g.nodes[0]!.label = 'Gmail triage';
    g.nodes[0]!.config = { note: 'scan gmail.com labels' };
    const v = validateGraph(g);
    check(v.ok === true, 'gmail.com business text allowed', JSON.stringify(v));
  }

  // ── Upgrade v1 → v2 ──────────────────────────────────────────────────────
  {
    const v1 = buildEmailTriageReadonlyV1Graph({
      readTools: ['mcp:gmail:gmail_list_messages'],
      categories: ['a'],
      summaryLanguage: 'zh-TW',
    });
    const snapshot = JSON.stringify(v1);
    const up = upgradeFlowGraphV1ToV2(v1);
    check(up.ok === true, 'email-triage v1 upgrades', JSON.stringify(up));
    check(JSON.stringify(v1) === snapshot, 'upgrade does not mutate input', '');
    if (up.ok) {
      check(up.graph.schemaVersion === 'aios.flow-graph/2', 'upgraded schemaVersion', up.graph.schemaVersion);
      check(up.graph.entryNodeId === 'n_input', 'entry is input', up.graph.entryNodeId);
      check(up.graph.exitNodeIds.includes('n_output'), 'exit includes output', up.graph.exitNodeIds.join(','));
      const v = validateGraph(up.graph);
      // tool.read nodes make validation pass if capability ok; gateway ok
      check(v.ok === true, 'upgraded email-triage validates', JSON.stringify(v));
      // Determinism
      const up2 = upgradeFlowGraphV1ToV2(v1);
      check(
        up2.ok && up.ok && JSON.stringify(up2.graph) === JSON.stringify(up.graph),
        'upgrade deterministic',
        '',
      );
    }
  }
  {
    const v1 = buildApprovalGatedActionV1Graph({
      approval: { reason: 'send', risk: 'high' },
      taskDescription: 'reply',
      readTools: ['mcp:gmail:gmail_list_messages'],
      writeTool: 'mcp:gmail:gmail_send_reply',
    });
    const up = upgradeFlowGraphV1ToV2(v1);
    check(up.ok === true, 'approval-gated v1 upgrades', '');
    if (up.ok) {
      const v = validateGraph(up.graph);
      check(v.ok === true, 'upgraded approval-gated validates', JSON.stringify(v));
    }
  }
  {
    const up = upgradeFlowGraphV1ToV2({ schemaVersion: 'nope' });
    check(up.ok === false, 'unknown schemaVersion upgrade fails', '');
  }

  // ── Condition edge requires condition object ─────────────────────────────
  {
    const g = echoGraph();
    g.edges[0] = {
      id: 'e_start_end',
      kind: 'condition',
      source: 'n_start',
      target: 'n_end',
      // missing condition
    };
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'INVALID_CONDITION'), 'condition edge needs condition', '');
  }

  summary('t01-schema-validate-upgrade');
}

main().catch((e) => {
  fail('main', e instanceof Error ? e.stack ?? e.message : String(e));
  summary('t01-schema-validate-upgrade');
  process.exit(1);
});
