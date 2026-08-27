import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aurionRoot = path.resolve(packageRoot, '../..');
const pluginName = 'aurion-aios-builder';

const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(`package.json is missing a semver version: ${JSON.stringify(version)}`);
}

function setTopLevelVersion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object with a top-level version');
  }
  value.version = version;
  return value;
}

function setMarketplacePluginVersion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a marketplace.json object');
  }
  const plugins = Array.isArray(value.plugins) ? value.plugins : [];
  const plugin = plugins.find((entry) => entry?.name === pluginName);
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`marketplace.json is missing plugins[] entry ${pluginName}`);
  }
  plugin.version = version;
  return value;
}

async function exists(file) {
  return stat(file).then(() => true, () => false);
}

async function* walkFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function updateJson(file, transform) {
  const next = `${JSON.stringify(transform(JSON.parse(await readFile(file, 'utf8'))), null, 2)}\n`;
  await writeFile(file, next, 'utf8');
  console.log(`Synced version ${version} → ${path.relative(packageRoot, file) || file}`);
}

const required = [
  [path.join(packageRoot, 'plugins', pluginName, '.claude-plugin', 'plugin.json'), setTopLevelVersion],
  [path.join(packageRoot, 'plugins', pluginName, '.codex-plugin', 'plugin.json'), setTopLevelVersion],
  [path.join(packageRoot, 'installers', 'marketplace.json'), setMarketplacePluginVersion],
  [path.join(aurionRoot, '.claude-plugin', 'marketplace.json'), setMarketplacePluginVersion],
];

for (const [file, transform] of required) {
  if (!(await exists(file))) {
    throw new Error(`Required version manifest is missing: ${file}`);
  }
  await updateJson(file, transform);
}

const releasesDir = path.join(packageRoot, 'releases');
for await (const file of walkFiles(releasesDir)) {
  const name = path.basename(file);
  if (name === 'plugin.json') {
    await updateJson(file, setTopLevelVersion);
  } else if (name === 'marketplace.json') {
    await updateJson(file, setMarketplacePluginVersion);
  }
}
