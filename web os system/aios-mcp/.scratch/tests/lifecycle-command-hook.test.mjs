import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyState,
  isAgentBuildPrompt,
  stateFileName,
  transitionLifecycle,
} from '../../plugins/aurion-aios-builder/scripts/lifecycle-hook-core.mjs';

const SESSION_ID = 'claude-session-123';

function transition(state, input) {
  return transitionLifecycle(state, { session_id: SESSION_ID, ...input });
}

test('recognizes explicit Agent and Skill work but not ordinary chat', () => {
  assert.equal(isAgentBuildPrompt('幫我建立一個會整理客訴信的 AI 員工'), true);
  assert.equal(isAgentBuildPrompt('訓練這個 Agent 每天九點收信'), true);
  assert.equal(isAgentBuildPrompt('修改客服 Skill，退款要主管核准'), true);
  assert.equal(isAgentBuildPrompt('今天天氣如何？'), false);
  assert.equal(isAgentBuildPrompt('Agent Builder 試跑：請依技能流程處理測試資料'), false);
  assert.equal(isAgentBuildPrompt('【Agent Builder 試跑】請依技能處理含「系統建置」的逐字稿'), false);
  assert.equal(isAgentBuildPrompt('Validate the Agent Builder test fixture'), false);
  assert.equal(isAgentBuildPrompt('Build a customer support Agent'), true);
});

test('SessionStart initializes lifecycle state without contacting AIOS for ordinary sessions', () => {
  const result = transition(null, {
    hook_event_name: 'SessionStart',
    source: 'startup',
  });

  assert.deepEqual(result.output, {});
  assert.equal(result.state.sessionId, SESSION_ID);
  assert.equal(result.state.sessionHandshakeSynced, false);
  assert.equal(result.state.agentBuildActive, false);
});

test('first explicit build prompt requires start and prompt MCP calls', () => {
  const initial = createEmptyState(SESSION_ID);
  const result = transition(initial, {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-1',
    prompt: '幫我建立一個客服 Agent',
  });
  const context = result.output.hookSpecificOutput.additionalContext;

  assert.match(context, /start_agent_build/);
  assert.match(context, /prepare_agent_build_prompt/);
  assert.match(context, /claude-session-123/);
  assert.equal(result.state.agentTurnActive, true);
  assert.equal(result.state.startRequired, true);
  assert.equal(result.state.promptRequired, true);
});

test('ordinary prompt remains a no-op before an Agent build starts', () => {
  const result = transition(createEmptyState(SESSION_ID), {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-ordinary',
    prompt: '請幫我整理今天的行程',
  });

  assert.deepEqual(result.output, {});
  assert.equal(result.state.agentTurnActive, false);
});

test('successful start and prompt tools close the pre-response half of the loop', () => {
  let state = transition(createEmptyState(SESSION_ID), {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-1',
    prompt: '幫我建立一個客服 Agent',
  }).state;

  state = transition(state, {
    hook_event_name: 'PostToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__plugin_aurion-aios-builder_aurion_aios__start_agent_build',
    tool_input: { externalConversationId: SESSION_ID },
    tool_response: { session: { id: 'build-1' } },
  }).state;
  state = transition(state, {
    hook_event_name: 'PostToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__plugin_aurion-aios-builder_aurion_aios__prepare_agent_build_prompt',
    tool_input: { externalConversationId: SESSION_ID },
    tool_response: { matched: true, sessionId: 'build-1' },
  }).state;

  assert.equal(state.sessionHandshakeSynced, true);
  assert.equal(state.startSynced, true);
  assert.equal(state.promptSynced, true);
  assert.equal(state.agentBuildActive, true);
  assert.equal(state.buildSessionId, 'build-1');
});

test('captures the internal build session id from wrapped MCP responses without retaining response content', () => {
  const secret = 'sk-response-secret';
  const pending = {
    ...createEmptyState(SESSION_ID),
    agentTurnActive: true,
    turnKey: 'prompt-1',
    startRequired: true,
  };
  const result = transition(pending, {
    hook_event_name: 'PostToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_aurion_aios__start_agent_build',
    tool_input: { externalConversationId: SESSION_ID },
    tool_response: {
      content: [{
        type: 'text',
        text: JSON.stringify({ session: { id: '01KZJP83K65X7YVS9RYBGEBNW3' }, note: secret }),
      }],
    },
  });

  assert.equal(result.state.buildSessionId, '01KZJP83K65X7YVS9RYBGEBNW3');
  assert.doesNotMatch(JSON.stringify(result), /sk-response-secret/);
});

test('later prompts in an active build sync even when the user only says continue', () => {
  const active = {
    ...createEmptyState(SESSION_ID),
    agentBuildActive: true,
    sessionHandshakeSynced: true,
  };
  const result = transition(active, {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-2',
    prompt: '繼續',
  });
  const context = result.output.hookSpecificOutput.additionalContext;

  assert.doesNotMatch(context, /start_agent_build/);
  assert.match(context, /prepare_agent_build_prompt/);
  assert.equal(result.state.promptRequired, true);
});

test('first Stop continues once and requires guard_agent_build_stop', () => {
  const ready = {
    ...createEmptyState(SESSION_ID),
    agentBuildActive: true,
    agentTurnActive: true,
    turnKey: 'prompt-1',
    sessionHandshakeSynced: true,
    startSynced: true,
    promptSynced: true,
  };
  const result = transition(ready, {
    hook_event_name: 'Stop',
    prompt_id: 'prompt-1',
    stop_hook_active: false,
    last_assistant_message: '完成第一輪需求整理。',
  });

  assert.match(result.output.hookSpecificOutput.additionalContext, /guard_agent_build_stop/);
  assert.match(result.output.hookSpecificOutput.additionalContext, /claude-session-123/);
  assert.equal(result.state.stopAttempts, 1);
  assert.equal(result.state.stopRequired, true);
});

test('successful stop guard lets the next Stop finish and resets only turn state', () => {
  let state = {
    ...createEmptyState(SESSION_ID),
    agentBuildActive: true,
    agentTurnActive: true,
    turnKey: 'prompt-1',
    promptSynced: true,
    stopRequired: true,
    stopAttempts: 1,
  };
  state = transition(state, {
    hook_event_name: 'PostToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__plugin_aurion-aios-builder_aurion_aios__guard_agent_build_stop',
    tool_input: { externalConversationId: SESSION_ID },
    tool_response: { matched: true, finalMessageSynced: true },
  }).state;
  const result = transition(state, {
    hook_event_name: 'Stop',
    prompt_id: 'prompt-1',
    stop_hook_active: true,
    last_assistant_message: '同步完成。',
  });

  assert.deepEqual(result.output, {});
  assert.equal(result.state.agentTurnActive, false);
  assert.equal(result.state.agentBuildActive, true);
  assert.equal(result.state.stopSynced, false);
});

test('Stop retries are bounded and fail safe instead of looping forever', () => {
  let state = {
    ...createEmptyState(SESSION_ID),
    agentBuildActive: true,
    agentTurnActive: true,
    turnKey: 'prompt-1',
    promptRequired: true,
  };
  const first = transition(state, {
    hook_event_name: 'Stop',
    prompt_id: 'prompt-1',
    stop_hook_active: false,
  });
  const second = transition(first.state, {
    hook_event_name: 'Stop',
    prompt_id: 'prompt-1',
    stop_hook_active: true,
  });
  const final = transition(second.state, {
    hook_event_name: 'Stop',
    prompt_id: 'prompt-1',
    stop_hook_active: true,
  });

  assert.match(second.output.hookSpecificOutput.additionalContext, /prepare_agent_build_prompt/);
  assert.deepEqual(final.output, {});
  assert.equal(final.state.agentTurnActive, false);
  assert.equal(final.state.lastFailure, 'stop-sync-retry-exhausted');
});

test('unrelated or spoofed tool calls cannot mark synchronization complete', () => {
  const pending = {
    ...createEmptyState(SESSION_ID),
    agentTurnActive: true,
    turnKey: 'prompt-1',
    promptRequired: true,
  };
  const unrelated = transition(pending, {
    hook_event_name: 'PostToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'Bash',
    tool_input: {},
  });
  const wrongSession = transition(pending, {
    hook_event_name: 'PostToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__plugin_aurion-aios-builder_aurion_aios__prepare_agent_build_prompt',
    tool_input: { externalConversationId: 'different-session' },
  });

  assert.equal(unrelated.state.promptSynced, false);
  assert.equal(wrongSession.state.promptSynced, false);
});

test('accepts the exact Claude Desktop connector aliases observed at runtime', () => {
  const pending = {
    ...createEmptyState(SESSION_ID),
    agentTurnActive: true,
    turnKey: 'prompt-1',
    promptRequired: true,
  };
  for (const toolName of [
    'mcp__claude_ai_aurion_aios__prepare_agent_build_prompt',
    'mcp__claude_ai_aurion_aios_2__prepare_agent_build_prompt',
  ]) {
    const result = transition(pending, {
      hook_event_name: 'PostToolUse',
      prompt_id: 'prompt-1',
      tool_name: toolName,
      tool_input: { externalConversationId: SESSION_ID },
    });
    assert.equal(result.state.promptSynced, true);
  }
});

test('auto-allows only lifecycle MCP calls for the active matching session', () => {
  const active = {
    ...createEmptyState(SESSION_ID),
    agentTurnActive: true,
    turnKey: 'prompt-1',
    promptRequired: true,
  };
  const allowed = transition(active, {
    hook_event_name: 'PermissionRequest',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_aurion_aios__prepare_agent_build_prompt',
    tool_input: { externalConversationId: SESSION_ID, prompt: 'not persisted' },
  });
  const unrelated = transition(active, {
    hook_event_name: 'PermissionRequest',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_gmail__send_email',
    tool_input: { externalConversationId: SESSION_ID },
  });
  const wrongSession = transition(active, {
    hook_event_name: 'PermissionRequest',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_aurion_aios__prepare_agent_build_prompt',
    tool_input: { externalConversationId: 'different-session' },
  });

  assert.equal(allowed.output.hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(allowed.output.hookSpecificOutput.decision.updatedInput, undefined);
  assert.deepEqual(unrelated.output, {});
  assert.deepEqual(wrongSession.output, {});
  assert.doesNotMatch(JSON.stringify(allowed), /not persisted/);
});

test('PreToolUse allows only required lifecycle tools before connector permission denial', () => {
  const active = {
    ...createEmptyState(SESSION_ID),
    agentTurnActive: true,
    turnKey: 'prompt-1',
    startRequired: true,
    promptRequired: true,
  };
  const allowed = transition(active, {
    hook_event_name: 'PreToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_aurion_aios__start_agent_build',
    tool_input: { externalConversationId: SESSION_ID, initialRequest: 'not persisted' },
  });
  const forbidden = transition(active, {
    hook_event_name: 'PreToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_aurion_aios__submit_agent_build_for_fde_review',
    tool_input: { externalConversationId: SESSION_ID },
  });

  assert.equal(allowed.output.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(allowed.output.hookSpecificOutput.permissionDecisionReason, /inert lifecycle/i);
  assert.deepEqual(forbidden.output, {});
  assert.doesNotMatch(JSON.stringify(allowed), /not persisted/);
});

test('auto-allows inert draft synchronization only for the captured internal build session', () => {
  const active = {
    ...createEmptyState(SESSION_ID),
    agentBuildActive: true,
    agentTurnActive: true,
    turnKey: 'prompt-1',
    buildSessionId: '01KZJP83K65X7YVS9RYBGEBNW3',
  };

  for (const toolKind of [
    'sync_agent_build_turn',
    'sync_agent_build_artifact',
    'upsert_agent_build_snapshot',
  ]) {
    const result = transition(active, {
      hook_event_name: 'PreToolUse',
      prompt_id: 'prompt-1',
      tool_name: `mcp__claude_ai_aurion_aios__${toolKind}`,
      tool_input: { sessionId: active.buildSessionId, artifact: { secret: 'not persisted' } },
    });
    assert.equal(result.output.hookSpecificOutput.permissionDecision, 'allow');
    assert.doesNotMatch(JSON.stringify(result), /not persisted/);
  }

  const wrongBuild = transition(active, {
    hook_event_name: 'PreToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_aurion_aios__upsert_agent_build_snapshot',
    tool_input: { sessionId: 'different-build' },
  });
  const upload = transition(active, {
    hook_event_name: 'PreToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_aurion_aios__upload_agent_build_file',
    tool_input: { sessionId: active.buildSessionId },
  });
  const submit = transition(active, {
    hook_event_name: 'PreToolUse',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_aurion_aios__submit_agent_build_for_fde_review',
    tool_input: { sessionId: active.buildSessionId },
  });

  assert.deepEqual(wrongBuild.output, {});
  assert.deepEqual(upload.output, {});
  assert.deepEqual(submit.output, {});
});

test('PermissionRequest applies the same internal build-id boundary to inert draft synchronization', () => {
  const active = {
    ...createEmptyState(SESSION_ID),
    agentTurnActive: true,
    turnKey: 'prompt-1',
    buildSessionId: 'build-verified',
  };
  const allowed = transition(active, {
    hook_event_name: 'PermissionRequest',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_aurion_aios_2__upsert_agent_build_snapshot',
    tool_input: { sessionId: 'build-verified' },
  });
  const denied = transition(active, {
    hook_event_name: 'PermissionRequest',
    prompt_id: 'prompt-1',
    tool_name: 'mcp__claude_ai_aurion_aios_2__upsert_agent_build_snapshot',
    tool_input: { sessionId: 'build-spoofed' },
  });

  assert.equal(allowed.output.hookSpecificOutput.decision.behavior, 'allow');
  assert.deepEqual(denied.output, {});
});

test('state and hook output never persist or echo prompts, assistant text, or credentials', () => {
  const secret = 'sk-example-do-not-copy';
  const result = transition(createEmptyState(SESSION_ID), {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-secret',
    prompt: `建立一個 Agent，密鑰是 ${secret}`,
    authorization: 'Bearer private-token',
    password: 'private-password',
  });
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /sk-example-do-not-copy/);
  assert.doesNotMatch(serialized, /private-token/);
  assert.doesNotMatch(serialized, /private-password/);
});

test('state filename is path-independent and rejects malformed sessions', () => {
  assert.match(stateFileName(SESSION_ID), /^[a-f0-9]{64}\.json$/);
  assert.equal(stateFileName('../../escape'), null);
  assert.equal(stateFileName(''), null);
});

test('malformed hook input fails safe', () => {
  assert.deepEqual(transitionLifecycle(null, null), {
    state: null,
    output: {},
  });
});
