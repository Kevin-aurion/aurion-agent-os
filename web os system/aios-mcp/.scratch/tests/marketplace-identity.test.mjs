import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageRoot = new URL('../../', import.meta.url);
const expectedMarketplace = 'aurion-aios-plugin-marketplace';
const expectedPlugin = 'aurion-aios-builder';
const expectedRepository = 'Kevin-aurion/aurion-aios-plugin-marketplace';
const expectedPluginPath = `./plugins/${expectedPlugin}`;
const expectedDisplayName = 'Aurion AIOS';

async function text(relativePath) {
  return readFile(new URL(relativePath, packageRoot), 'utf8');
}

/**
 * Extract the gptMarketplace object literal from the sync script without executing it.
 * Avoids running destructive mkdir/rm/cp against a real marketplace checkout.
 */
function extractGptMarketplaceFromSyncScript(syncScript) {
  const start = syncScript.indexOf('const gptMarketplace = {');
  assert.ok(start >= 0, 'sync script must define const gptMarketplace');
  const braceStart = syncScript.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < syncScript.length; i += 1) {
    const ch = syncScript[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > braceStart, 'failed to parse gptMarketplace object bounds');
  // Bind script identifiers to expected constants without executing the sync script body.
  const objectSource = syncScript.slice(braceStart, end)
    .replaceAll(/\bmarketplaceName\b/g, JSON.stringify(expectedMarketplace))
    .replaceAll(/\bmarketplaceDisplayName\b/g, JSON.stringify(expectedDisplayName))
    .replaceAll(/\bpluginName\b/g, JSON.stringify(expectedPlugin));
  // Template literals like `./plugins/${"aurion-aios-builder"}` evaluate correctly here.
  return Function(`"use strict"; return (${objectSource});`)();
}

test('marketplace identity matches the private GitHub repository slug in every installer path', async () => {
  const marketplace = JSON.parse(await text('installers/marketplace.json'));
  const syncScript = await text('scripts/sync-github-marketplace.mjs');
  const macInstaller = await text('installers/Install Aurion AIOS.command');
  const windowsInstaller = await text('installers/Install-Aurion-AIOS.ps1');

  assert.equal(marketplace.name, expectedMarketplace);
  assert.match(syncScript, new RegExp(`const marketplaceName = '${expectedMarketplace}'`));
  assert.match(macInstaller, new RegExp(`plugin install --scope user aurion-aios-builder@${expectedMarketplace}\\b`));
  assert.match(windowsInstaller, new RegExp(`plugin install --scope user aurion-aios-builder@${expectedMarketplace}\\b`));
});

test('marketplace and plugin manifests publish one identical version', async () => {
  const marketplace = JSON.parse(await text('installers/marketplace.json'));
  const claudePlugin = JSON.parse(await text('plugins/aurion-aios-builder/.claude-plugin/plugin.json'));
  const codexPlugin = JSON.parse(await text('plugins/aurion-aios-builder/.codex-plugin/plugin.json'));

  assert.equal(marketplace.plugins[0].version, claudePlugin.version);
  assert.equal(codexPlugin.version, claudePlugin.version);
});

test('plugin uses a product-specific MCP server id so stale generic aios connectors cannot win', async () => {
  const mcp = JSON.parse(await text('plugins/aurion-aios-builder/.mcp.json'));
  const serverNames = Object.keys(mcp.mcpServers ?? {});

  assert.deepEqual(serverNames, ['aurion_aios']);
  assert.equal(mcp.mcpServers.aurion_aios.url, 'https://aurion-aios-mcp.lazyoffice.app/mcp');
  assert.equal(mcp.mcpServers.aios, undefined);
});

test('sync script publishes Codex GPT marketplace with official schema and shared identity', async () => {
  const syncScript = await text('scripts/sync-github-marketplace.mjs');
  const claudeMarketplace = JSON.parse(await text('installers/marketplace.json'));
  const gptMarketplace = extractGptMarketplaceFromSyncScript(syncScript);

  // Writes both catalogs into the same target repo
  assert.match(syncScript, /\.agents['",/\s]*plugins/);
  assert.match(syncScript, /path\.join\(targetRoot, '\.agents', 'plugins', 'marketplace\.json'\)/);
  assert.match(syncScript, /path\.join\(targetRoot, '\.claude-plugin', 'marketplace\.json'\)/);

  // Official Codex schema — exact literals
  assert.deepEqual(Object.keys(gptMarketplace).sort(), ['interface', 'name', 'plugins']);
  assert.equal(gptMarketplace.name, expectedMarketplace);
  assert.equal(gptMarketplace.name, 'aurion-aios-plugin-marketplace');
  assert.deepEqual(gptMarketplace.interface, { displayName: expectedDisplayName });
  assert.deepEqual(gptMarketplace.interface, { displayName: 'Aurion AIOS' });
  assert.equal(gptMarketplace.plugins?.length, 1);
  const entry = gptMarketplace.plugins[0];
  assert.equal(entry.name, expectedPlugin);
  assert.equal(entry.name, 'aurion-aios-builder');
  assert.deepEqual(entry.source, { source: 'local', path: expectedPluginPath });
  assert.deepEqual(entry.source, { source: 'local', path: './plugins/aurion-aios-builder' });
  assert.deepEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.equal(entry.policy.installation, 'AVAILABLE');
  assert.equal(entry.policy.authentication, 'ON_INSTALL');
  assert.equal(entry.category, 'Productivity');

  // Same marketplace identity + same plugin as Claude catalog
  assert.equal(gptMarketplace.name, claudeMarketplace.name);
  assert.equal(entry.name, claudeMarketplace.plugins[0].name);
  assert.equal(entry.source.path, claudeMarketplace.plugins[0].source);

  // No second plugin entry, no foreign repo sources in GPT catalog
  assert.equal(gptMarketplace.plugins.length, 1);
  assert.notEqual(entry.source.source, 'github');
  assert.equal(entry.source.url, undefined);
  assert.equal(entry.repository, undefined);
});

test('sync script stages .agents on commit/push and documents one shared repository', async () => {
  const syncScript = await text('scripts/sync-github-marketplace.mjs');

  assert.match(
    syncScript,
    /git',\s*\['add',\s*markerName,\s*'\.claude-plugin',\s*'\.agents',\s*'plugins',\s*'README\.md'\]/,
  );

  // Exact Codex CLI install commands in generated README template
  assert.match(syncScript, /codex plugin marketplace add \$\{marketplaceRepository\}/);
  assert.match(syncScript, /codex plugin add \$\{pluginName\}@\$\{marketplaceName\}/);
  assert.match(
    syncScript,
    new RegExp(
      `\\|\\| '${expectedRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`,
    ),
  );

  // Shared private repo supports ChatGPT Desktop Plugins, Codex CLI, and Claude
  assert.match(syncScript, /ChatGPT Desktop Plugins/);
  assert.match(syncScript, /Codex CLI/);
  assert.match(syncScript, /Claude/);
  assert.match(syncScript, /One private GitHub repository/);
  assert.match(syncScript, /supports \*\*ChatGPT Desktop Plugins\*\*, \*\*Codex CLI\*\*, and \*\*Claude\*\*/);

  // Claude install paths retained
  assert.match(syncScript, /\/plugin marketplace add \$\{marketplaceRepository\}/);
  assert.match(syncScript, /\/plugin install \$\{pluginName\}@\$\{marketplaceName\}/);
  assert.match(syncScript, /\/plugin marketplace update \$\{marketplaceName\}/);
});

test('sync script uses a single marketplace repository slug (no second repo)', async () => {
  const syncScript = await text('scripts/sync-github-marketplace.mjs');

  assert.match(
    syncScript,
    new RegExp(`\\|\\| '${expectedRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
  );

  // owner/name-style GitHub slugs that look like marketplace repos
  const slugMatches = [...syncScript.matchAll(/['"`]([a-z0-9-]+\/[a-z0-9._-]*marketplace[a-z0-9._-]*)['"`]/gi)]
    .map((m) => m[1]);
  const unique = [...new Set(slugMatches)];
  assert.deepEqual(unique, [expectedRepository], `expected only ${expectedRepository}, got ${unique.join(', ')}`);

  // Must not introduce an alternate default marketplace org/repo constant
  assert.doesNotMatch(syncScript, /openai\/.*marketplace/i);
  assert.doesNotMatch(syncScript, /anthropic\/.*marketplace/i);
  assert.doesNotMatch(syncScript, /aurion-aios-plugin-marketplace-codex/);
  assert.doesNotMatch(syncScript, /aurion-aios-plugin-marketplace-gpt/);
});

test('GPT marketplace extraction fails closed on missing object (negative)', async () => {
  assert.throws(
    () => extractGptMarketplaceFromSyncScript('// no marketplace object here\nconst x = 1;\n'),
    /must define const gptMarketplace/,
  );
});
