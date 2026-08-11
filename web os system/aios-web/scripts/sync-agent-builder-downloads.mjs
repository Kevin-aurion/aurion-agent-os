import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpRoot = path.resolve(webRoot, '..', 'aios-mcp');
const releasesRoot = path.join(mcpRoot, 'releases');
const destinationRoot = path.join(webRoot, 'public', 'downloads', 'agent-builder');

const files = [
  ['lazyoffice-aios-builder-plugin.zip', path.join(releasesRoot, 'lazyoffice-aios-builder-plugin.zip')],
  ['build-aios-agent.skill.zip', path.join(releasesRoot, 'build-aios-agent.skill.zip')],
  ['lazyoffice-aios-one-click-install.zip', path.join(releasesRoot, 'lazyoffice-aios-one-click-install.zip')],
  ['SHA256SUMS.txt', path.join(releasesRoot, 'SHA256SUMS.txt')],
  ['REMOTE-MCP-URL.txt', path.join(releasesRoot, 'REMOTE-MCP-URL.txt')],
  ['aios-remote-mcp.json', path.join(mcpRoot, 'plugins', 'lazyoffice-aios-builder', '.mcp.json')],
  ['AIOS-Agent-Builder-Installation-Guide.zh-TW.md', path.join(mcpRoot, 'docs', 'INSTALLATION.zh-TW.md')],
];

await mkdir(destinationRoot, { recursive: true });

const manifest = [];
for (const [name, source] of files) {
  const target = path.join(destinationRoot, name);
  await copyFile(source, target);
  const bytes = await readFile(target);
  const info = await stat(target);
  manifest.push({
    name,
    bytes: info.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

const mcpConfig = await readFile(path.join(destinationRoot, 'aios-remote-mcp.json'), 'utf8');
if (!mcpConfig.includes('https://aios-mcp.lazyoffice.app/mcp') || mcpConfig.includes('127.0.0.1')) {
  throw new Error('Refusing to publish an Agent Builder MCP config that is not the hosted Remote MCP.');
}

await writeFile(
  path.join(destinationRoot, 'manifest.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), files: manifest }, null, 2)}\n`,
  'utf8',
);

console.log(`Synced ${files.length} Agent Builder downloads to ${destinationRoot}`);
