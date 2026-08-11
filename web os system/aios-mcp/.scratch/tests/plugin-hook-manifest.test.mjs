import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const hooksPath = new URL(
  '../../plugins/lazyoffice-aios-builder/hooks/hooks.json',
  import.meta.url,
);

test('plugin declares the complete command-hook lifecycle', async () => {
  const manifest = JSON.parse(await readFile(hooksPath, 'utf8'));
  const hooks = manifest.hooks;

  assert.deepEqual(Object.keys(hooks).sort(), [
    'PermissionRequest',
    'PostToolUse',
    'PreToolUse',
    'SessionStart',
    'Stop',
    'UserPromptSubmit',
  ]);
  for (const event of Object.values(hooks)) {
    for (const group of event) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command');
        assert.equal(hook.command, 'node');
        assert.deepEqual(hook.args, [
          '${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.mjs',
        ]);
      }
    }
  }
  assert.match(hooks.PostToolUse[0].matcher, /start_agent_build/);
  assert.match(hooks.PostToolUse[0].matcher, /prepare_agent_build_prompt/);
  assert.match(hooks.PostToolUse[0].matcher, /guard_agent_build_stop/);
  assert.equal(hooks.PermissionRequest[0].matcher, hooks.PostToolUse[0].matcher);
  assert.equal(hooks.PreToolUse[0].matcher, hooks.PostToolUse[0].matcher);
  assert.match(hooks.PreToolUse[1].matcher, /sync_agent_build_turn/);
  assert.match(hooks.PreToolUse[1].matcher, /sync_agent_build_artifact/);
  assert.match(hooks.PreToolUse[1].matcher, /upsert_agent_build_snapshot/);
  assert.doesNotMatch(hooks.PreToolUse[1].matcher, /upload_agent_build_file/);
  assert.doesNotMatch(hooks.PreToolUse[1].matcher, /submit_agent_build_for_fde_review/);
  assert.equal(hooks.PermissionRequest[1].matcher, hooks.PreToolUse[1].matcher);
  for (const event of Object.values(hooks)) {
    for (const group of event) {
      if (!group.matcher) continue;
      assert.match(group.matcher, /lazyoffice_aios/);
      assert.doesNotMatch(group.matcher, /plugin_lazyoffice-aios-builder_aios\|/);
    }
  }
});
