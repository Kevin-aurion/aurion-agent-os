import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClaudeArgs } from '../../src/engine/claude.ts';
import { BUILDER_SHADOW_DISABLE_ALL_TOOLS } from '../../src/lib/builderconversation.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '../..');
const conversationSource = fs.readFileSync(
  path.join(serverRoot, 'src/lib/builderconversation.ts'),
  'utf8',
);

assert.equal(BUILDER_SHADOW_DISABLE_ALL_TOOLS, true);

const args = buildClaudeArgs({
  prompt: 'shadow test',
  cwd: serverRoot,
  safeMode: true,
  disableAllTools: BUILDER_SHADOW_DISABLE_ALL_TOOLS,
});

const toolsIndex = args.indexOf('--tools');
assert.notEqual(toolsIndex, -1, 'Shadow Claude subprocess must explicitly disable all tools');
assert.equal(args[toolsIndex + 1], '', '`--tools` must receive an empty tool set');
assert.equal(args.includes('--disallowedTools'), false, 'Shadow must not rely on a drifting deny list');
assert.equal(conversationSource.includes("'Computer'"), false, 'Unknown Computer tool must not return');

console.log('ok - Shadow Claude uses an empty tool set and no unknown deny rules');
