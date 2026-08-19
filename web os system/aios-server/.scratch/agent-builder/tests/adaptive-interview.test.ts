/**
 * Adaptive Agent Builder interview — pure acceptance tests.
 * Run: npx tsx .scratch/agent-builder/tests/adaptive-interview.test.ts
 */
import {
  applyAnswer,
  buildContextualInterviewTurn,
  buildProgress,
  inferFromPrompt,
} from '../../../src/lib/agentbuilder.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function main() {
  const news = inferFromPrompt('我想建立一個每天早上到網路上找 AI 新聞的 Agent');
  assert(news.brief.tags?.includes('research'), 'AI news request should be recognized as research');
  assert(news.answered.includes('inputs'), 'public web is a known runtime source');
  assert(news.answered.includes('process'), 'research method can be proposed from the intent');
  assert(!news.answered.includes('outputs'), 'delivery format must not be invented');

  const progress = buildProgress(news.answered);
  assert(progress.currentKey === 'outputs', 'next question should clarify the research deliverable');

  const outputTurn = buildContextualInterviewTurn('outputs', news.brief);
  assert(outputTurn.question.includes('找完資料'), 'question must reference the research task');
  assert(
    outputTurn.suggestions.some((suggestion) => suggestion.includes('來源連結')),
    'research suggestions should include source-backed output',
  );
  assert(
    outputTurn.sourceAdvice.mode === 'hidden',
    'web research must not push a fixed training-file upload',
  );

  const noUpload = applyAnswer(
    { objective: '整理臨時交辦事項', tags: [] },
    'inputs',
    '這個沒有資料要上傳，也不需要固定訓練來源',
  );
  assert(
    noUpload.sources === '不使用固定訓練檔案',
    'no-upload answer should become a valid source strategy',
  );

  const financeTurn = buildContextualInterviewTurn('testData', {
    objective: '核對應收帳款',
    tags: ['finance', 'spreadsheet'],
  });
  assert(financeTurn.sourceAdvice.mode === 'recommended', 'a finance example may be recommended');
  assert(
    financeTurn.sourceAdvice.reason.includes('沒有也能繼續'),
    'recommended source must remain optional',
  );

  const generatedFixture = applyAnswer(
    { objective: '每天找 AI 新聞', tags: ['research'] },
    'testData',
    '請系統先產生一組模擬測試資料',
  );
  assert(
    generatedFixture.testDataHint?.includes('AI Agent 新聞'),
    'system can offer a domain-specific test fixture',
  );
  assert(
    generatedFixture.expectedResult?.includes('合併重複消息'),
    'generated fixture has a concrete expected outcome',
  );

  console.log('✓ research intent skips irrelevant fixed-source questions');
  console.log('✓ next question and reply options are task-specific');
  console.log('✓ training files remain optional');
  console.log('✓ system-generated test fixture is domain-specific');
}

main();
