import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releases = path.join(packageRoot, 'releases');
const pluginSource = path.join(packageRoot, 'plugins', 'aurion-aios-builder');
const skillNames = ['build-aios-agent', 'use-aios-agent'];
const installers = path.join(packageRoot, 'installers');
const staging = path.join(releases, 'aurion-aios-one-click');
const marketplace = path.join(staging, 'marketplace');

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

await mkdir(releases, { recursive: true });

// Keep the distributable plugin Skills byte-for-byte aligned with the canonical Skills.
for (const skillName of skillNames) {
  const pluginSkill = path.join(pluginSource, 'skills', skillName);
  await rm(pluginSkill, { recursive: true, force: true });
  await mkdir(path.dirname(pluginSkill), { recursive: true });
  await cp(path.join(packageRoot, 'skills', skillName), pluginSkill, { recursive: true });
}

await rm(staging, { recursive: true, force: true });
await mkdir(path.join(marketplace, '.claude-plugin'), { recursive: true });
await mkdir(path.join(marketplace, 'plugins'), { recursive: true });
await cp(pluginSource, path.join(marketplace, 'plugins', 'aurion-aios-builder'), { recursive: true });
await cp(path.join(installers, 'marketplace.json'), path.join(marketplace, '.claude-plugin', 'marketplace.json'));
await cp(path.join(installers, 'Install Aurion AIOS.command'), path.join(staging, 'Install Aurion AIOS.command'));
await cp(path.join(installers, 'Install-Aurion-AIOS.ps1'), path.join(staging, 'Install-Aurion-AIOS.ps1'));
await cp(path.join(installers, '安裝說明.txt'), path.join(staging, '安裝說明.txt'));
for (const skillName of skillNames) {
  await cp(path.join(packageRoot, 'skills', skillName), path.join(staging, skillName), { recursive: true });
}
await chmod(path.join(staging, 'Install Aurion AIOS.command'), 0o755);

const expectedUrl = 'https://aios-mcp.lazyoffice.app/mcp';
const packagedMcp = await readFile(path.join(marketplace, 'plugins', 'aurion-aios-builder', '.mcp.json'), 'utf8');
if (!packagedMcp.includes(expectedUrl) || packagedMcp.includes('127.0.0.1')) {
  throw new Error('Refusing to package a client that does not exclusively reference the hosted Remote MCP.');
}

const pluginZip = path.join(releases, 'aurion-aios-builder-plugin.zip');
const skillZips = skillNames.map((skillName) => path.join(releases, `${skillName}.skill.zip`));
const oneClickZip = path.join(releases, 'aurion-aios-one-click-install.zip');
await Promise.all([pluginZip, ...skillZips, oneClickZip].map((file) => rm(file, { force: true })));

await run('zip', ['-qry', pluginZip, 'aurion-aios-builder'], path.dirname(pluginSource));
for (const [index, skillName] of skillNames.entries()) {
  await run('zip', ['-qry', skillZips[index], skillName], path.join(packageRoot, 'skills'));
}
await run('zip', ['-qry', oneClickZip, path.basename(staging)], releases);

const checksumLines = [];
for (const file of [pluginZip, ...skillZips, oneClickZip]) {
  const digest = createHash('sha256').update(await readFile(file)).digest('hex');
  checksumLines.push(`${digest}  ${path.basename(file)}`);
}
await writeFile(path.join(releases, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`, 'utf8');

await writeFile(
  path.join(releases, 'REMOTE-MCP-URL.txt'),
  `${expectedUrl}\n\nAgent Builds: https://aurion-aios.lazyoffice.app/agent-builds\n`,
  'utf8',
);

console.log(`Created ${pluginZip}`);
for (const skillZip of skillZips) console.log(`Created ${skillZip}`);
console.log(`Created ${oneClickZip}`);
