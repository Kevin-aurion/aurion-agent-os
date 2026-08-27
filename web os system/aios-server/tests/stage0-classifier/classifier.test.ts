/**
 * Stage-0 Agent-build classifier + naming + fallback + lifecycle latch.
 *
 * Run from `web os system/`:
 *   npx tsx aios-server/tests/stage0-classifier/classifier.test.ts
 */
import assert from 'node:assert/strict';
import {
  AGENT_BUILD_ACTION_RE,
  AGENT_BUILD_CONFIRM_START_HINT,
  AGENT_BUILD_OBJECT_RE,
  hookResultForUnstartedBuild,
  isExplicitAgentBuildPrompt,
} from '../../src/lib/externalagentbuilder.ts';
import { inferFromPrompt } from '../../src/lib/agentbuilder.ts';
import { fallbackPayload } from '../../src/lib/agentbuilderevolution.ts';
import {
  createEmptyState,
  isAgentBuildPrompt,
  transitionLifecycle,
} from '../../../aios-mcp/plugins/aurion-aios-builder/scripts/lifecycle-hook-core.mjs';

const NEGATIVE = [
  '幫我修改 src/tools/agentbuilder.ts 的型別',
  'run npm run build in the agent package',
  '繼續看剛剛那個 workflow',
  '這個 agent 架構請你分析一下',
] as const;

const POSITIVE = '幫我建立一個報價單 AI 員工';
const NAME_TRAP = '幫我做出一個 agent 治理稽核';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

test('English action/object tokens use word boundaries; Chinese tokens do not', () => {
  assert.match(AGENT_BUILD_ACTION_RE.source, /\\b\(\?:create\|build\|train\|teach\|design\)\\b/);
  assert.match(AGENT_BUILD_OBJECT_RE.source, /\\bagent\\b/);
  assert.match(AGENT_BUILD_OBJECT_RE.source, /\\bbot\\b/);
  assert.match(AGENT_BUILD_OBJECT_RE.source, /\\bskill\\b/);
  assert.doesNotMatch(AGENT_BUILD_ACTION_RE.source, /\\b建立/);
  assert.doesNotMatch(AGENT_BUILD_OBJECT_RE.source, /\\b技能/);
});

test('negative: coding / review sentences are not build intent', () => {
  for (const prompt of NEGATIVE) {
    assert.equal(
      isExplicitAgentBuildPrompt(prompt),
      false,
      `expected not-build: ${prompt}`,
    );
  }
});

test('positive: hiring an AI employee is build intent', () => {
  assert.equal(isExplicitAgentBuildPrompt(POSITIVE), true);
});

test('positive English collocation is still detected', () => {
  assert.equal(isExplicitAgentBuildPrompt('please create an agent for quotes'), true);
  assert.equal(isExplicitAgentBuildPrompt('build a sales bot'), true);
});

test('no existing session: hint to confirm start_agent_build, do not create', () => {
  const miss = hookResultForUnstartedBuild(NEGATIVE[0]);
  assert.equal(miss.matched, false);
  assert.equal(miss.created, undefined);

  const hit = hookResultForUnstartedBuild(POSITIVE);
  assert.equal(hit.matched, true);
  assert.equal(hit.created, false);
  assert.equal(hit.userMessageSynced, false);
  assert.equal(hit.backgroundBuildQueued, false);
  assert.equal(hit.sessionId, undefined);
  assert.match(String(hit.additionalContext), /start_agent_build/);
  assert.equal(hit.additionalContext, AGENT_BUILD_CONFIRM_START_HINT);
  assert.match(AGENT_BUILD_CONFIRM_START_HINT, /偵測到可能的建置意圖，請與使用者確認後呼叫 start_agent_build/);
});

test('naming: 做出一個 agent must not capture 出一個', () => {
  const name = inferFromPrompt(NAME_TRAP).brief.requestedAgentName;
  assert.notEqual(name, '出一個');
  assert.equal(name, undefined);
});

test('naming: 建立一個報價單 AI 員工 still extracts 報價單', () => {
  assert.equal(inferFromPrompt(POSITIVE).brief.requestedAgentName, '報價單');
});

test('fallbackPayload marks source:fallback and does not dump a long prompt', () => {
  const longPrompt = `請把整段需求重寫成員工：${'客戶對帳與例外處理流程，'.repeat(20)}還要記得寄信。`;
  assert.ok(longPrompt.length > 200);
  const payload = fallbackPayload(
    { brief: {}, transcript: [] },
    null,
    longPrompt,
    'message',
  );
  assert.match(payload.changes[0]?.summary ?? '', /source:'fallback'/);
  assert.equal(payload.understanding.facts.some((fact) => fact.source === 'fallback'), true);

  const decisions = payload.understanding.decisions.map((row) => row.decision);
  const facts = payload.harness.memory.facts;
  const instructions = payload.harness.skills.flatMap((skill) => skill.instructions);
  for (const field of [...decisions, ...facts, ...instructions]) {
    assert.equal(field.includes(longPrompt), false, `dumped full prompt: ${field.slice(0, 80)}`);
  }
  assert.equal(decisions.some((row) => row.includes('待模型重跑')), true);
  assert.equal(facts.some((row) => row.includes('待模型重跑')), true);
  assert.equal(instructions.some((row) => row.includes('待模型重跑')), true);
  for (const field of [...decisions, ...facts, ...instructions].filter((row) => row.includes('待模型重跑'))) {
    const withoutMark = field.replace(/（待模型重跑）/g, '').replace(/…/g, '');
    assert.ok(withoutMark.length <= 220, `excerpt too long (${withoutMark.length}): ${field.slice(0, 80)}`);
  }
});

test('agentBuildActive releases after 3 consecutive non-build UserPromptSubmit', () => {
  const sessionId = 'claude-session-classifier';
  const startTool = 'mcp__plugin_aurion-aios-builder_aurion_aios__start_agent_build';
  let state = createEmptyState(sessionId);
  assert.equal(state.agentBuildActive, false);

  let result = transitionLifecycle(state, {
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    prompt: POSITIVE,
    prompt_id: 'turn-1',
  });
  state = result.state;
  assert.ok(result.output?.hookSpecificOutput);
  assert.equal(isAgentBuildPrompt(POSITIVE), true);

  result = transitionLifecycle(state, {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    prompt_id: 'turn-1',
    tool_name: startTool,
    tool_input: { externalConversationId: sessionId },
    tool_response: { session: { id: 'build-session-1' } },
  });
  state = result.state;
  assert.equal(state.agentBuildActive, true);

  const unrelated = [
    'please review this pull request',
    'sum these three invoice totals',
    'what time is the standup',
  ];
  for (const [index, prompt] of unrelated.entries()) {
    result = transitionLifecycle(state, {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt,
      prompt_id: `miss-${index + 1}`,
    });
    state = result.state;
    if (index < 2) {
      assert.equal(state.agentBuildActive, true, `miss ${index + 1} should keep the latch`);
      assert.ok(result.output?.hookSpecificOutput, `miss ${index + 1} should still be a build turn`);
    } else {
      assert.equal(state.agentBuildActive, false, 'third miss must release the latch');
      assert.deepEqual(result.output, {});
    }
  }
});

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
