import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearedSemanticVerdicts,
  isPositionOnlyNodePatch,
  saveCurrentThenCompile,
} from './actions';
import { createDefaultEchoGraph } from './model';
import type { GraphEnvironment, GraphSpecV2 } from './types';

test('saveCurrentThenCompile always compiles the id returned from saving the current graph', async () => {
  const graph = createDefaultEchoGraph();
  graph.name = 'edited-after-stale-id';
  graph.revision = 3;

  const staleUiSourceId = 'source_STALE_from_previous_session';
  const freshSourceId = 'source_FRESH_from_current_save';

  const saveCalls: GraphSpecV2[] = [];
  const compileCalls: Array<{ sourceId: string; environment: GraphEnvironment }> = [];

  const result = await saveCurrentThenCompile(graph, 'SANDBOX', {
    saveSource: async (g) => {
      saveCalls.push(structuredClone(g));
      // Content-address: same bytes reuse; here we always return the fresh id for this graph.
      return { id: freshSourceId, reused: false, digest: 'sha256:fresh' };
    },
    compileArtifact: async (sourceId, environment) => {
      compileCalls.push({ sourceId, environment });
      return {
        source: { id: sourceId },
        compiled: { id: 'compiled_native_1', digest: 'sha256:compiled' },
      };
    },
  });

  assert.equal(saveCalls.length, 1, 'must save current graph exactly once');
  assert.equal(saveCalls[0]!.name, 'edited-after-stale-id');
  assert.equal(saveCalls[0]!.revision, 3);
  assert.equal(result.sourceId, freshSourceId);
  assert.equal(compileCalls.length, 1);
  assert.equal(
    compileCalls[0]!.sourceId,
    freshSourceId,
    'compile must use the save response id, not UI cache',
  );
  assert.notEqual(compileCalls[0]!.sourceId, staleUiSourceId);
  assert.equal(compileCalls[0]!.environment, 'SANDBOX');
  assert.equal(result.compile.compiled.id, 'compiled_native_1');
});

test('saveCurrentThenCompile never consults a stale lastSourceId argument (none exists)', async () => {
  // API surface has no lastSourceId parameter — prove sequencing only uses save → compile.
  const graph = createDefaultEchoGraph();
  let compileSourceId = '';

  await saveCurrentThenCompile(graph, 'STAGING', {
    saveSource: async () => ({ id: 'src_only_from_save', reused: true }),
    compileArtifact: async (sourceId) => {
      compileSourceId = sourceId;
      return { compiled: { id: 'c1' } };
    },
  });

  assert.equal(compileSourceId, 'src_only_from_save');
});

test('saveCurrentThenCompile rejects empty save ids fail-closed', async () => {
  const graph = createDefaultEchoGraph();
  await assert.rejects(
    () =>
      saveCurrentThenCompile(graph, 'SANDBOX', {
        saveSource: async () => ({ id: '' }),
        compileArtifact: async () => ({ compiled: { id: 'x' } }),
      }),
    /source artifact id/,
  );
});

test('clearedSemanticVerdicts drops compile badge, mapping, issues, diff, and success note', () => {
  const cleared = clearedSemanticVerdicts();
  assert.deepEqual(cleared.issues, []);
  assert.deepEqual(cleared.nodeMapping, []);
  assert.equal(cleared.compileOk, null);
  assert.equal(cleared.compileMessage, null);
  assert.equal(cleared.diff, null);
  assert.equal(cleared.actionNote, null);
});

test('isPositionOnlyNodePatch distinguishes canvas moves from semantic edits', () => {
  assert.equal(isPositionOnlyNodePatch({ position: { x: 1, y: 2 } }), true);
  assert.equal(isPositionOnlyNodePatch({ label: 'x' }), false);
  assert.equal(isPositionOnlyNodePatch({ position: { x: 1, y: 2 }, label: 'x' }), false);
  assert.equal(isPositionOnlyNodePatch({ config: { risk: 'high' } }), false);
  assert.equal(isPositionOnlyNodePatch({}), false);
});
