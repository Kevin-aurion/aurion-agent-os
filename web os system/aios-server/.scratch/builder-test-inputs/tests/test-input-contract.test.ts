import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFixtureExtension,
  getTestInputStatus,
  inferTestInputRequirements,
  normalizeTestInputRequirements,
  parseBuilderTestData,
} from '../../../src/lib/buildertestinputs.js';

test('normalizes an explicit required SRT and optional requirements document contract', () => {
  const requirements = normalizeTestInputRequirements([
    {
      key: 'meeting_transcript',
      label: '會議逐字稿',
      description: '客戶會議的 SRT 或 VTT 逐字稿',
      kind: 'FILE',
      required: true,
      acceptedExtensions: ['SRT', '.vtt', '.txt'],
      minFiles: 1,
      maxFiles: 1,
    },
    {
      key: 'requirement_documents',
      label: '需求文件',
      kind: 'FILE',
      required: false,
      acceptedExtensions: ['.pdf', '.docx'],
    },
  ]);

  assert.deepEqual(requirements[0]?.acceptedExtensions, ['.srt', '.vtt', '.txt']);
  assert.equal(requirements[0]?.minFiles, 1);
  assert.equal(requirements[1]?.minFiles, 0);
  assert.equal(requirements[1]?.maxFiles, 1);
});

test('infers the AI landing proposal fixture contract from skill inputs and tests', () => {
  const requirements = inferTestInputRequirements({
    identityName: 'AI 落地提案師',
    skills: [{ inputs: ['客戶會議逐字稿（SRT）', '需求文件（PDF，選填）'] }],
    testIdeas: [{
      name: '產生提案',
      input: '提供完整 SRT 逐字稿，需求 PDF 可選填',
      expected: '產生模組清單與報價提案',
    }],
  });

  assert.equal(requirements.find((item) => item.key === 'meeting_transcript')?.required, true);
  assert.equal(requirements.find((item) => item.key === 'requirement_documents')?.required, false);
});

test('required fixture gates the test while optional fixture does not', () => {
  const requirements = normalizeTestInputRequirements([
    { key: 'transcript', label: '逐字稿', kind: 'FILE', required: true, acceptedExtensions: ['.srt'] },
    { key: 'brief', label: '需求文件', kind: 'FILE', required: false, acceptedExtensions: ['.pdf'] },
  ]);

  const missing = getTestInputStatus(requirements, parseBuilderTestData(null));
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.missingRequiredKeys, ['transcript']);

  const complete = getTestInputStatus(requirements, parseBuilderTestData({
    version: 1,
    fixtures: [{
      id: 'fixture-1',
      requirementKey: 'transcript',
      name: 'meeting.srt',
      mimeType: 'application/x-subrip',
      size: 128,
      content: '1\n00:00:00,000 --> 00:00:01,000\n測試',
      uploadedAt: '2026-08-10T00:00:00.000Z',
    }],
  }));
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missingRequiredKeys, []);
});

test('rejects a file whose extension is not permitted by its requirement', () => {
  const [requirement] = normalizeTestInputRequirements([
    { key: 'transcript', label: '逐字稿', kind: 'FILE', required: true, acceptedExtensions: ['.srt', '.vtt'] },
  ]);
  assert.throws(() => assertFixtureExtension(requirement!, 'payload.exe'), /不支援/);
  assert.doesNotThrow(() => assertFixtureExtension(requirement!, 'meeting.SRT'));
});

test('falls back to required text input when an Agent has no file requirement', () => {
  const requirements = inferTestInputRequirements({
    identityName: '文字回覆員工',
    skills: [{ inputs: ['使用者問題'] }],
    testIdeas: [{ name: '回覆', input: '輸入一句問題', expected: '正確回答' }],
  });
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0]?.kind, 'TEXT');
  assert.equal(requirements[0]?.required, true);
});
