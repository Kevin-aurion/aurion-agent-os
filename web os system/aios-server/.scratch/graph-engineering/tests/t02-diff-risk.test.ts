/**
 * T02 — Structural diff + governance risk classifier.
 * Run: npx tsx .scratch/graph-engineering/tests/t02-diff-risk.test.ts
 */
import { cloneGraph, diffGraphs } from '../../../src/graph/diff.js';
import { approvalGatedGraph, check, echoGraph, fail, resetCounters, summary } from './helpers.js';

async function main(): Promise<void> {
  resetCounters();
  console.log('── t02-diff-risk ──');

  // Move-only → LOW
  {
    const a = echoGraph();
    const b = cloneGraph(a);
    b.nodes[1]!.position = { x: 999, y: 50 };
    const d = diffGraphs(a, b);
    check(
      d.changes.some((c) => c.type === 'node.move') && d.risk === 'LOW',
      'move-only is LOW',
      JSON.stringify(d),
    );
    // Determinism
    const d2 = diffGraphs(a, b);
    check(JSON.stringify(d) === JSON.stringify(d2), 'diff deterministic', '');
  }

  // Semantic config change → MEDIUM
  {
    const a = echoGraph();
    const b = cloneGraph(a);
    b.nodes[0]!.config = { note: 'changed' };
    const d = diffGraphs(a, b);
    check(
      d.changes.some((c) => c.type === 'node.change') && d.risk === 'MEDIUM',
      'config change is MEDIUM',
      JSON.stringify(d),
    );
  }

  // Approval / gated involvement → HIGH
  {
    const a = echoGraph();
    const b = approvalGatedGraph();
    const d = diffGraphs(a, b);
    check(d.risk === 'HIGH', 'introducing gated/approval is HIGH', d.summary);
  }
  {
    const a = approvalGatedGraph();
    const b = cloneGraph(a);
    b.nodes = b.nodes.filter((n) => n.kind !== 'tool.gated' && n.id !== 'n_gate');
    b.edges = b.edges.filter((e) => e.source !== 'n_gate' && e.target !== 'n_gate');
    // reconnect checkpoint → out
    b.edges = b.edges.filter((e) => e.id !== 'e2' && e.id !== 'e3');
    b.edges.push({ id: 'e_fix', kind: 'default', source: 'n_cp', target: 'n_out' });
    const d = diffGraphs(a, b);
    check(d.risk === 'HIGH', 'removing gated tool is HIGH', d.summary);
  }

  // Loop edge → HIGH
  {
    const a = echoGraph();
    const b = cloneGraph(a);
    b.nodes.push({
      id: 'n_loop',
      kind: 'control.loop',
      label: 'loop',
      position: { x: 250, y: 100 },
      config: {},
    });
    b.edges = [
      { id: 'e1', kind: 'default', source: 'n_start', target: 'n_loop' },
      { id: 'e2', kind: 'default', source: 'n_loop', target: 'n_end' },
      { id: 'e3', kind: 'loop', source: 'n_loop', target: 'n_start', maxTraversals: 2 },
    ];
    const d = diffGraphs(a, b);
    check(d.risk === 'HIGH', 'loop introduction is HIGH', d.summary);
  }

  // Edge add/remove + entry/exit
  {
    const a = echoGraph();
    const b = cloneGraph(a);
    b.entryNodeId = 'n_end';
    // make still somewhat valid structurally for diff only
    const d = diffGraphs(a, b);
    check(
      d.changes.some((c) => c.type === 'entry.change') && (d.risk === 'MEDIUM' || d.risk === 'HIGH'),
      'entry change not LOW',
      d.summary,
    );
  }

  // Identical → empty LOW
  {
    const a = echoGraph();
    const d = diffGraphs(a, cloneGraph(a));
    check(d.changes.length === 0 && d.risk === 'LOW', 'identical graphs empty LOW', '');
  }

  // No mutation
  {
    const a = echoGraph();
    const b = cloneGraph(a);
    const snapA = JSON.stringify(a);
    const snapB = JSON.stringify(b);
    diffGraphs(a, b);
    check(JSON.stringify(a) === snapA && JSON.stringify(b) === snapB, 'diff does not mutate', '');
  }

  summary('t02-diff-risk');
}

main().catch((e) => {
  fail('main', e instanceof Error ? e.stack ?? e.message : String(e));
  summary('t02-diff-risk');
  process.exit(1);
});
