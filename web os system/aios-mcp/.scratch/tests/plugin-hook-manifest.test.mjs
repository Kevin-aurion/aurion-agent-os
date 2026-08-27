import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const hooksPath = new URL(
  '../../plugins/aurion-aios-builder/hooks/hooks.json',
  import.meta.url,
);

test('plugin keeps only the inert SessionStart hook in the stage-0 client', async () => {
  const manifest = JSON.parse(await readFile(hooksPath, 'utf8'));
  const hooks = manifest.hooks;

  assert.deepEqual(Object.keys(hooks), ['SessionStart']);
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
  assert.equal(hooks.SessionStart[0].matcher, undefined);
  assert.doesNotMatch(JSON.stringify(manifest), /UserPromptSubmit|PermissionRequest|PostToolUse|PreToolUse|"Stop"/);
});
