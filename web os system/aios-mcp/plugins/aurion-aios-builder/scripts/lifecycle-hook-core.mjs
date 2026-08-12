import { createHash } from 'node:crypto';

// English actions must be complete words. Matching `build` inside the product
// noun `Builder` causes internal Agent Builder sandbox tests to recursively
// activate this plugin and replace the actual test result with sync chatter.
const BUILD_ACTION_RE = /(?:建立|建構|建置|新增|設計|製作|訓練|教(?:會|導)?|修改|更新|調整|改善|優化|重寫|繼續|恢復|續接|\b(?:build|create|design|train|teach|revise|update|improve|resume|continue)\b)/iu;
const BUILD_OBJECT_RE = /(?:agent|ai\s*(?:employee|assistant|agent)|人工智慧(?:員工|助理|代理)|ai\s*員工|智能體|代理人|技能|skill|工作流|workflow)/iu;
const INTERNAL_SANDBOX_PROMPT_RE = /^\s*【Agent Builder 試跑】/u;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/u;
const SAFE_PROMPT_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/u;
// Use a product-specific server id. A generic `aios` connector can remain in
// Claude's OAuth cache and silently route calls to an older AIOS deployment.
const AURION_SERVER_RE = '(?:plugin_aurion-aios-builder_aurion_aios|claude_ai_aurion_aios(?:_2)?)';
const LIFECYCLE_TOOL_RE = new RegExp(`^mcp__${AURION_SERVER_RE}__(start_agent_build|prepare_agent_build_prompt|guard_agent_build_stop)$`, 'u');
const DRAFT_SYNC_TOOL_RE = new RegExp(`^mcp__${AURION_SERVER_RE}__(sync_agent_build_turn|sync_agent_build_artifact|upsert_agent_build_snapshot)$`, 'u');
const MAX_STOP_ATTEMPTS = 2;
const MAX_TOOL_RESPONSE_TEXT = 1_000_000;

export function isAgentBuildPrompt(prompt) {
  return typeof prompt === 'string'
    && prompt.length > 0
    && !INTERNAL_SANDBOX_PROMPT_RE.test(prompt)
    && BUILD_ACTION_RE.test(prompt)
    && BUILD_OBJECT_RE.test(prompt);
}

function safeSessionId(value) {
  return typeof value === 'string' && SAFE_SESSION_ID_RE.test(value) ? value : null;
}

function safePromptId(value) {
  return typeof value === 'string' && SAFE_PROMPT_ID_RE.test(value) ? value : null;
}

export function stateFileName(sessionId) {
  const safe = safeSessionId(sessionId);
  if (!safe) return null;
  return `${createHash('sha256').update(safe, 'utf8').digest('hex')}.json`;
}

export function createEmptyState(sessionId) {
  const safe = safeSessionId(sessionId);
  if (!safe) return null;
  return {
    version: 2,
    sessionId: safe,
    agentBuildActive: false,
    sessionHandshakeSynced: false,
    agentTurnActive: false,
    turnSequence: 0,
    turnKey: null,
    buildSessionId: null,
    startRequired: false,
    startSynced: false,
    promptRequired: false,
    promptSynced: false,
    stopRequired: false,
    stopSynced: false,
    stopAttempts: 0,
    lastFailure: null,
  };
}

function normalizeState(previous, sessionId) {
  const empty = createEmptyState(sessionId);
  if (!empty) return null;
  if (!previous || typeof previous !== 'object' || previous.sessionId !== sessionId) return empty;
  return {
    ...empty,
    agentBuildActive: previous.agentBuildActive === true,
    sessionHandshakeSynced: previous.sessionHandshakeSynced === true,
    agentTurnActive: previous.agentTurnActive === true,
    turnSequence: Number.isSafeInteger(previous.turnSequence) && previous.turnSequence >= 0
      ? previous.turnSequence
      : 0,
    turnKey: safePromptId(previous.turnKey),
    buildSessionId: safeSessionId(previous.buildSessionId),
    startRequired: previous.startRequired === true,
    startSynced: previous.startSynced === true,
    promptRequired: previous.promptRequired === true,
    promptSynced: previous.promptSynced === true,
    stopRequired: previous.stopRequired === true,
    stopSynced: previous.stopSynced === true,
    stopAttempts: Number.isSafeInteger(previous.stopAttempts) && previous.stopAttempts >= 0
      ? Math.min(previous.stopAttempts, MAX_STOP_ATTEMPTS)
      : 0,
    lastFailure: previous.lastFailure === 'stop-sync-retry-exhausted'
      ? previous.lastFailure
      : null,
  };
}

function hookContext(event, lines) {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: lines.join(' '),
    },
  };
}

function promptContext(state) {
  const calls = [];
  if (state.startRequired && !state.startSynced) {
    calls.push(
      'First call the connected Aurion AIOS MCP tool `start_agent_build` with the exact current user prompt as `initialRequest`, '
      + `externalConversationId \`${state.sessionId}\`, and source \`CLAUDE_CODE\`.`,
    );
  }
  calls.push(
    'Then call `prepare_agent_build_prompt` with the exact current user prompt as `prompt`, '
    + `externalConversationId \`${state.sessionId}\`, and source \`CLAUDE_CODE\`.`,
  );
  return hookContext('UserPromptSubmit', [
    'Aurion AIOS lifecycle gate: this is an Agent or Skill build/training turn.',
    ...calls,
    'Do not answer until the required MCP calls succeed. Treat their results as hidden operational context.',
    'If synchronization fails, state exactly that it was not synchronized. Never approve, activate, publish, or grant permissions automatically.',
  ]);
}

function stopContext(state) {
  const calls = [];
  if (state.startRequired && !state.startSynced) {
    calls.push(
      'Call `start_agent_build` with the exact user prompt for this turn as `initialRequest`, '
      + `externalConversationId \`${state.sessionId}\`, and source \`CLAUDE_CODE\`.`,
    );
  }
  if (state.promptRequired && !state.promptSynced) {
    calls.push(
      'Call `prepare_agent_build_prompt` with the exact user prompt for this turn as `prompt`, '
      + `externalConversationId \`${state.sessionId}\`, and source \`CLAUDE_CODE\`.`,
    );
  }
  calls.push(
    'Call `guard_agent_build_stop` with '
    + `externalConversationId \`${state.sessionId}\`, the exact completed assistant response immediately preceding this Stop feedback as \`lastAssistantMessage\`, \`stopHookActive: true\`, and source \`CLAUDE_CODE\`.`,
  );
  return hookContext('Stop', [
    'Aurion AIOS has not yet confirmed the complete lifecycle for this Agent-building turn.',
    ...calls,
    'After every required MCP call succeeds, finish without repeating the user-facing answer. If a call fails, report the synchronization failure once.',
  ]);
}

function resetTurn(state, failure = null) {
  return {
    ...state,
    agentTurnActive: false,
    turnKey: null,
    startRequired: false,
    startSynced: false,
    promptRequired: false,
    promptSynced: false,
    stopRequired: false,
    stopSynced: false,
    stopAttempts: 0,
    lastFailure: failure,
  };
}

function sameTurn(state, input) {
  const promptId = safePromptId(input.prompt_id);
  return !promptId || !state.turnKey || promptId === state.turnKey;
}

function lifecycleToolKind(toolName) {
  if (typeof toolName !== 'string') return null;
  return LIFECYCLE_TOOL_RE.exec(toolName)?.[1] ?? null;
}

function draftSyncToolKind(toolName) {
  if (typeof toolName !== 'string') return null;
  return DRAFT_SYNC_TOOL_RE.exec(toolName)?.[1] ?? null;
}

function extractBuildSessionId(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > MAX_TOOL_RESPONSE_TEXT) return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return extractBuildSessionId(JSON.parse(trimmed), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 32)) {
      const found = extractBuildSessionId(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const direct = safeSessionId(value.session?.id);
  if (direct) return direct;
  for (const key of ['structuredContent', 'mcpMeta', 'content', 'text']) {
    const found = extractBuildSessionId(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function isRequiredLifecycleTool(state, toolKind) {
  return (toolKind === 'start_agent_build' && state.startRequired)
    || (toolKind === 'prepare_agent_build_prompt' && state.promptRequired)
    || (toolKind === 'guard_agent_build_stop' && state.stopRequired);
}

export function transitionLifecycle(previous, input) {
  if (!input || typeof input !== 'object') return { state: null, output: {} };
  const sessionId = safeSessionId(input.session_id);
  if (!sessionId) return { state: null, output: {} };
  let state = normalizeState(previous, sessionId);
  if (!state) return { state: null, output: {} };

  switch (input.hook_event_name) {
    case 'SessionStart': {
      state = resetTurn(state);
      state.sessionHandshakeSynced = false;
      return { state, output: {} };
    }
    case 'UserPromptSubmit': {
      const relevant = isAgentBuildPrompt(input.prompt) || state.agentBuildActive;
      if (!relevant || typeof input.prompt !== 'string') return { state, output: {} };
      const nextSequence = state.turnSequence + 1;
      const turnKey = safePromptId(input.prompt_id) ?? `turn-${nextSequence}`;
      state = {
        ...state,
        agentTurnActive: true,
        turnSequence: nextSequence,
        turnKey,
        startRequired: !state.sessionHandshakeSynced,
        startSynced: state.sessionHandshakeSynced,
        promptRequired: true,
        promptSynced: false,
        stopRequired: false,
        stopSynced: false,
        stopAttempts: 0,
        lastFailure: null,
      };
      return { state, output: promptContext(state) };
    }
    case 'PreToolUse': {
      if (!state.agentTurnActive || !sameTurn(state, input)) return { state, output: {} };
      const toolKind = lifecycleToolKind(input.tool_name);
      const draftToolKind = draftSyncToolKind(input.tool_name);
      const lifecycleAllowed = toolKind
        && safeSessionId(input.tool_input?.externalConversationId) === sessionId
        && isRequiredLifecycleTool(state, toolKind);
      const draftAllowed = draftToolKind
        && state.buildSessionId
        && safeSessionId(input.tool_input?.sessionId) === state.buildSessionId;
      if (!lifecycleAllowed && !draftAllowed) {
        return { state, output: {} };
      }
      return {
        state,
        output: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Aurion AIOS inert lifecycle or draft synchronization for the active matching session.',
          },
        },
      };
    }
    case 'PermissionRequest': {
      if (!state.agentTurnActive || !sameTurn(state, input)) return { state, output: {} };
      const toolKind = lifecycleToolKind(input.tool_name);
      const draftToolKind = draftSyncToolKind(input.tool_name);
      const lifecycleAllowed = toolKind
        && safeSessionId(input.tool_input?.externalConversationId) === sessionId
        && isRequiredLifecycleTool(state, toolKind);
      const draftAllowed = draftToolKind
        && state.buildSessionId
        && safeSessionId(input.tool_input?.sessionId) === state.buildSessionId;
      if (!lifecycleAllowed && !draftAllowed) return { state, output: {} };
      return {
        state,
        output: {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
          },
        },
      };
    }
    case 'PostToolUse': {
      if (!state.agentTurnActive || !sameTurn(state, input)) return { state, output: {} };
      const toolKind = lifecycleToolKind(input.tool_name);
      if (!toolKind) return { state, output: {} };
      const toolConversationId = safeSessionId(input.tool_input?.externalConversationId);
      if (toolConversationId !== sessionId) return { state, output: {} };

      if (toolKind === 'start_agent_build') {
        const buildSessionId = extractBuildSessionId(input.tool_response);
        if (buildSessionId) state.buildSessionId = buildSessionId;
        state.startSynced = true;
        state.sessionHandshakeSynced = true;
        state.agentBuildActive = true;
      } else if (toolKind === 'prepare_agent_build_prompt') {
        state.promptSynced = true;
        state.agentBuildActive = true;
      } else if (toolKind === 'guard_agent_build_stop' && state.stopRequired) {
        state.stopSynced = true;
      }
      return { state, output: {} };
    }
    case 'Stop': {
      if (!state.agentTurnActive || !sameTurn(state, input)) return { state, output: {} };
      if (state.stopSynced) return { state: resetTurn(state), output: {} };
      if (state.stopAttempts >= MAX_STOP_ATTEMPTS) {
        return {
          state: resetTurn(state, 'stop-sync-retry-exhausted'),
          output: {},
        };
      }
      state.stopRequired = true;
      state.stopAttempts += 1;
      return { state, output: stopContext(state) };
    }
    default:
      return { state, output: {} };
  }
}
