import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const hookScript = path.resolve(
  'plugins/lazyoffice-aios-builder/scripts/lifecycle-hook.mjs',
);

function runHook(pluginData, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`hook exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

test('CLI persists a complete prompt-to-stop lifecycle without sensitive content', async () => {
  const pluginData = await mkdtemp(path.join(tmpdir(), 'lazyoffice-hook-test-'));
  const common = { session_id: 'cli-session-1', prompt_id: 'prompt-1' };

  assert.deepEqual(await runHook(pluginData, {
    ...common,
    hook_event_name: 'SessionStart',
    source: 'startup',
  }), {});
  const promptOutput = await runHook(pluginData, {
    ...common,
    hook_event_name: 'UserPromptSubmit',
    prompt: '建立一個客服 Agent，密鑰 sk-do-not-store',
  });
  assert.match(promptOutput.hookSpecificOutput.additionalContext, /start_agent_build/);

  await runHook(pluginData, {
    ...common,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__plugin_lazyoffice-aios-builder_lazyoffice_aios__start_agent_build',
    tool_input: { externalConversationId: 'cli-session-1' },
  });
  await runHook(pluginData, {
    ...common,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__plugin_lazyoffice-aios-builder_lazyoffice_aios__prepare_agent_build_prompt',
    tool_input: { externalConversationId: 'cli-session-1' },
  });
  const stopOutput = await runHook(pluginData, {
    ...common,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: '完成，密碼 private-password',
  });
  assert.match(stopOutput.hookSpecificOutput.additionalContext, /guard_agent_build_stop/);

  await runHook(pluginData, {
    ...common,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__plugin_lazyoffice-aios-builder_lazyoffice_aios__guard_agent_build_stop',
    tool_input: { externalConversationId: 'cli-session-1' },
  });
  assert.deepEqual(await runHook(pluginData, {
    ...common,
    hook_event_name: 'Stop',
    stop_hook_active: true,
  }), {});

  const stateDirectory = path.join(pluginData, 'lifecycle-state');
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(stateDirectory));
  assert.equal(entries.length, 1);
  const statePath = path.join(stateDirectory, entries[0]);
  const stored = await readFile(statePath, 'utf8');
  const mode = (await stat(statePath)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.doesNotMatch(stored, /sk-do-not-store|private-password/);
});

test('CLI fails safe on malformed JSON and missing plugin data path', async () => {
  const pluginData = await mkdtemp(path.join(tmpdir(), 'lazyoffice-hook-test-'));
  assert.deepEqual(await runHook(pluginData, '{broken'), {});
  assert.deepEqual(await runHook('', {
    session_id: 'cli-session-2',
    hook_event_name: 'SessionStart',
  }), {});
});
