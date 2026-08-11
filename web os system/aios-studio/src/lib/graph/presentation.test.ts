import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactKindLabel,
  artifactKindTone,
  canAccessGraphWorkbench,
  compileStatusTone,
  formatCompileNativeActionNote,
  governanceSaveCopy,
  isLangflowDeployableArtifact,
  paletteGroupLabel,
  riskTone,
  studioGraphSection,
} from './presentation';
import { studioSections } from '../presentation';

test('Graph 工程 navigation entry lives under Governance/Execution', () => {
  const entry = studioSections.find((s) => s.href === '/studio/graph');
  assert.ok(entry, 'studioSections must include /studio/graph');
  assert.equal(entry!.label, 'Graph 工程');
  assert.equal(entry!.group, '治理與執行');
  assert.deepEqual(studioGraphSection, entry);
});

test('FDE gate presentation helpers', () => {
  assert.equal(canAccessGraphWorkbench('OWNER'), true);
  assert.equal(canAccessGraphWorkbench('TRAINER'), true);
  assert.equal(canAccessGraphWorkbench('MEMBER'), false);
  assert.equal(canAccessGraphWorkbench(undefined), false);
  assert.equal(canAccessGraphWorkbench(null), false);
  assert.match(governanceSaveCopy(), /Save ≠ Deploy|Save != Deploy|儲存不是部署|不是 Production/i);
});

test('artifact kind and deployability presentation', () => {
  assert.equal(artifactKindLabel('source'), 'Source GraphSpec');
  assert.equal(artifactKindLabel('langflow-native'), 'Langflow Native');
  assert.equal(artifactKindTone('source'), 'info');
  assert.equal(artifactKindTone('langflow-native'), 'positive');
  assert.equal(isLangflowDeployableArtifact({ artifactKind: 'source', langflowDeployable: false }), false);
  assert.equal(isLangflowDeployableArtifact({ artifactKind: 'langflow-native', langflowDeployable: true }), true);
  // Never treat source as deployable even if a buggy flag says so
  assert.equal(isLangflowDeployableArtifact({ artifactKind: 'source', langflowDeployable: true }), false);
});

test('risk and compile status tones stay governance-safe', () => {
  assert.equal(riskTone('LOW'), 'info');
  assert.equal(riskTone('MEDIUM'), 'warning');
  assert.equal(riskTone('HIGH'), 'danger');
  assert.equal(compileStatusTone('mapped'), 'positive');
  assert.equal(compileStatusTone('unsupported'), 'danger');
  assert.equal(paletteGroupLabel('input_output'), 'Input / Output');
  assert.equal(paletteGroupLabel('governance'), 'Governance');
  assert.equal(paletteGroupLabel('composition'), 'Composition');
});

test('formatCompileNativeActionNote uses short compiled id + ellipsis, never digest', () => {
  const compiledId = 'compiled_native_abc123xyz';
  const digest = 'sha256:deadbeefcafe';
  const note = formatCompileNativeActionNote(compiledId);

  assert.equal(note, 'Langflow native artifact stored · compiled_n…');
  assert.match(note, /compiled_n…$/);
  assert.doesNotMatch(note, /sha256|deadbeef|digest/i);
  assert.doesNotMatch(note, /REDACTED/i);
  // Even if a caller has a digest available, the pure helper only accepts id —
  // proving digest cannot leak into the success note.
  assert.notEqual(note.includes(digest.slice(0, 12)), true);
  assert.equal(formatCompileNativeActionNote('short'), 'Langflow native artifact stored · short…');
});
