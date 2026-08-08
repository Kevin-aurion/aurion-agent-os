import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultTarget = path.resolve(packageRoot, '../../..', 'aurion-aios-plugin-marketplace');
const pluginName = 'aurion-aios-builder';
const marketplaceName = 'aurion-aios';
const markerName = '.aurion-aios-marketplace';
const expectedMcpUrl = 'https://aurion-aios-mcp.lazyoffice.app/mcp';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args, cwd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`)));
  });
}

async function exists(file) {
  return stat(file).then(() => true, () => false);
}

const targetRoot = path.resolve(argValue('--target') ?? defaultTarget);
if (targetRoot === '/' || targetRoot === packageRoot || targetRoot.length < 20) {
  throw new Error(`Refusing unsafe marketplace target: ${targetRoot}`);
}

const markerPath = path.join(targetRoot, markerName);
const targetExists = await exists(targetRoot);
if (targetExists && !(await exists(markerPath))) {
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(targetRoot));
  if (entries.length > 0) {
    throw new Error(`Refusing to overwrite unmarked non-empty directory: ${targetRoot}`);
  }
}

const sourcePlugin = path.join(packageRoot, 'plugins', pluginName);
const canonicalSkill = path.join(packageRoot, 'skills', 'build-aios-agent');
const sourceMarketplace = JSON.parse(
  await readFile(path.join(packageRoot, 'installers', 'marketplace.json'), 'utf8'),
);
const pluginManifest = JSON.parse(
  await readFile(path.join(sourcePlugin, '.claude-plugin', 'plugin.json'), 'utf8'),
);
const marketplaceEntry = sourceMarketplace.plugins?.find((plugin) => plugin.name === pluginName);
if (!marketplaceEntry) throw new Error(`Marketplace entry is missing ${pluginName}`);
if (marketplaceEntry.version !== pluginManifest.version) {
  throw new Error(
    `Version mismatch: plugin=${pluginManifest.version}, marketplace=${marketplaceEntry.version}`,
  );
}
if (sourceMarketplace.name !== marketplaceName) {
  throw new Error(`Unexpected marketplace name: ${sourceMarketplace.name}`);
}

const mcpConfig = await readFile(path.join(sourcePlugin, '.mcp.json'), 'utf8');
if (!mcpConfig.includes(expectedMcpUrl) || mcpConfig.includes('127.0.0.1')) {
  throw new Error('Refusing to publish a Plugin that does not exclusively use the hosted MCP.');
}

await mkdir(targetRoot, { recursive: true });
await writeFile(markerPath, `${marketplaceName}\n`, 'utf8');
await mkdir(path.join(targetRoot, '.claude-plugin'), { recursive: true });
await mkdir(path.join(targetRoot, 'plugins'), { recursive: true });

const targetPlugin = path.join(targetRoot, 'plugins', pluginName);
await rm(targetPlugin, { recursive: true, force: true });
await cp(sourcePlugin, targetPlugin, { recursive: true });
await rm(path.join(targetPlugin, 'skills', 'build-aios-agent'), { recursive: true, force: true });
await mkdir(path.join(targetPlugin, 'skills'), { recursive: true });
await cp(canonicalSkill, path.join(targetPlugin, 'skills', 'build-aios-agent'), { recursive: true });

await writeFile(
  path.join(targetRoot, '.claude-plugin', 'marketplace.json'),
  `${JSON.stringify(sourceMarketplace, null, 2)}\n`,
  'utf8',
);
await writeFile(
  path.join(targetRoot, 'README.md'),
  `# Aurion AIOS Plugin Marketplace

Private Claude Plugin marketplace for Aurion AIOS customers.

## Install

In Claude Cowork, open **Customize → Plugins → Add marketplace** and add:

\`Kevin-aurion/aurion-aios-plugin-marketplace\`

In Claude Code:

\`/plugin marketplace add Kevin-aurion/aurion-aios-plugin-marketplace\`

\`/plugin install ${pluginName}@${marketplaceName}\`

## Update

Cowork users click **Update** on the marketplace. Claude Code users run:

\`/plugin marketplace update ${marketplaceName}\`

The Plugin connects only to ${expectedMcpUrl}. Installation does not grant AIOS access; every user must still authenticate with an enabled AIOS account through OAuth.

Version: ${pluginManifest.version}
`,
  'utf8',
);

await run('claude', ['plugin', 'validate', targetPlugin], targetRoot);
await run('claude', ['plugin', 'validate', targetRoot], targetRoot);

const gitDir = path.join(targetRoot, '.git');
if (!(await exists(gitDir))) {
  await run('git', ['init', '-b', 'main'], targetRoot);
}

if (process.argv.includes('--commit') || process.argv.includes('--push')) {
  await run('git', ['add', markerName, '.claude-plugin', 'plugins', 'README.md'], targetRoot);
  const staged = await run('git', ['diff', '--cached', '--name-only'], targetRoot, { capture: true });
  if (staged) {
    await run('git', ['commit', '-m', `Release ${pluginName} v${pluginManifest.version}`], targetRoot);
  } else {
    console.log(`Marketplace is already at ${pluginManifest.version}; nothing to commit.`);
  }
}

if (process.argv.includes('--push')) {
  const remotes = await run('git', ['remote'], targetRoot, { capture: true });
  if (!remotes.split(/\s+/).includes('origin')) {
    throw new Error('Marketplace repository has no origin remote. Create the private GitHub repository first.');
  }
  await run('git', ['push', '-u', 'origin', 'main'], targetRoot);
}

console.log(JSON.stringify({
  targetRoot,
  marketplace: marketplaceName,
  plugin: pluginName,
  version: pluginManifest.version,
  privateRepositoryRecommended: true,
}, null, 2));
