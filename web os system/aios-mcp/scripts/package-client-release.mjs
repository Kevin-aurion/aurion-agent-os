import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const aurionRoot = path.resolve(packageRoot, '../..');
const updaterSource = path.join(installers, 'updater');
const updaterMarketplace = path.join(updaterSource, 'marketplace');
const legacyMacUpdaterStaging = path.join(releases, 'aurion-aios-plugin-updater-macos');
const previousMacUpdaterStagings = [
  path.join(releases, 'aurion-aios-plugin-updater-macos-v2'),
  path.join(releases, 'aurion-aios-plugin-updater-macos-v3'),
  path.join(releases, 'aurion-aios-plugin-updater-macos-v4'),
];
const macUpdaterStaging = path.join(releases, 'aurion-aios-plugin-updater-macos-v5');
const windowsUpdaterStaging = path.join(releases, 'aurion-aios-plugin-updater-windows');

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

// skills/ is the unique Skill content source. Plugin and release copies are
// always regenerated here so SKILL.md / agents/openai.yaml cannot drift.
for (const skillName of skillNames) {
  const canonical = path.join(packageRoot, 'skills', skillName);
  const pluginSkill = path.join(pluginSource, 'skills', skillName);
  await rm(pluginSkill, { recursive: true, force: true });
  await mkdir(path.dirname(pluginSkill), { recursive: true });
  await cp(canonical, pluginSkill, { recursive: true });
  console.log(`Copied skills/${skillName} → plugins/aurion-aios-builder/skills/${skillName}`);
}

// The updater carries a complete local marketplace for first-time installs.
// Refresh its plugin payload from the canonical source before packaging so the
// installer and updater can never drift from the published plugin.
const updaterMarketplacePlugin = path.join(updaterMarketplace, 'plugins', 'aurion-aios-builder');
await rm(updaterMarketplacePlugin, { recursive: true, force: true });
await mkdir(path.dirname(updaterMarketplacePlugin), { recursive: true });
await cp(pluginSource, updaterMarketplacePlugin, { recursive: true });

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
  console.log(`Copied skills/${skillName} → releases/aurion-aios-one-click/${skillName}`);
}
await chmod(path.join(staging, 'Install Aurion AIOS.command'), 0o755);

// Click-to-run update packages for users who should not need to type commands.
await rm(legacyMacUpdaterStaging, { recursive: true, force: true });
await Promise.all(previousMacUpdaterStagings.map((directory) => rm(directory, { recursive: true, force: true })));
await rm(macUpdaterStaging, { recursive: true, force: true });
const macUpdaterApp = path.join(macUpdaterStaging, 'Aurion AIOS Updater.app');
const macUpdaterContents = path.join(macUpdaterApp, 'Contents');
const macUpdaterResources = path.join(macUpdaterContents, 'Resources');
await mkdir(path.join(macUpdaterContents, 'MacOS'), { recursive: true });
await mkdir(macUpdaterResources, { recursive: true });
await cp(
  path.join(updaterSource, 'macos', 'Aurion AIOS Updater.command'),
  path.join(macUpdaterStaging, 'Aurion AIOS Updater.command'),
);
await cp(path.join(updaterSource, '使用說明.txt'), path.join(macUpdaterStaging, 'README.txt'));
await writeFile(
  path.join(macUpdaterStaging, 'VERSION.txt'),
  'Aurion AIOS Mac 安裝／更新工具 v5\n電腦沒有 Claude Code 或 Codex 時，會先安裝官方 Codex CLI，再安裝 Plugin 並完成 MCP 授權。\n',
  'utf8',
);
await cp(path.join(updaterSource, 'macos', 'Info.plist'), path.join(macUpdaterContents, 'Info.plist'));
await cp(
  path.join(updaterSource, 'macos', 'Aurion AIOS Updater'),
  path.join(macUpdaterContents, 'MacOS', 'Aurion AIOS Updater'),
);
await cp(
  path.join(aurionRoot, 'update-aios-plugins.sh'),
  path.join(macUpdaterResources, 'update-aios-plugins.sh'),
);
await cp(updaterMarketplace, path.join(macUpdaterResources, 'marketplace'), { recursive: true });
await chmod(path.join(macUpdaterStaging, 'Aurion AIOS Updater.command'), 0o755);
await chmod(path.join(macUpdaterContents, 'MacOS', 'Aurion AIOS Updater'), 0o755);
await chmod(path.join(macUpdaterResources, 'update-aios-plugins.sh'), 0o755);

await rm(windowsUpdaterStaging, { recursive: true, force: true });
await mkdir(path.join(windowsUpdaterStaging, 'resources'), { recursive: true });
await cp(
  path.join(updaterSource, 'windows', 'Aurion AIOS Updater.cmd'),
  path.join(windowsUpdaterStaging, 'Aurion AIOS Updater.cmd'),
);
await cp(
  path.join(updaterSource, 'windows', 'Aurion AIOS Updater.vbs'),
  path.join(windowsUpdaterStaging, 'Aurion AIOS Updater.vbs'),
);
await cp(path.join(updaterSource, '使用說明.txt'), path.join(windowsUpdaterStaging, 'README.txt'));
await writeFile(
  path.join(windowsUpdaterStaging, 'VERSION.txt'),
  'Aurion AIOS Windows 安裝／更新工具 v4\n可從 ZIP 預覽自動補齊完整套件；沒有 Claude Code 或 Codex 時，會先安裝官方 Codex CLI。\n',
  'utf8',
);
const windowsScript = await readFile(
  path.join(updaterSource, 'windows', 'Update-Aurion-AIOS-Plugins.ps1'),
);
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
await writeFile(
  path.join(windowsUpdaterStaging, 'resources', 'Update-Aurion-AIOS-Plugins.ps1'),
  windowsScript.subarray(0, 3).equals(utf8Bom)
    ? windowsScript
    : Buffer.concat([utf8Bom, windowsScript]),
);
await cp(
  updaterMarketplace,
  path.join(windowsUpdaterStaging, 'resources', 'marketplace'),
  { recursive: true },
);

const expectedUrl = 'https://aurion-aios-mcp.lazyoffice.app/mcp';
const packagedMcp = await readFile(path.join(marketplace, 'plugins', 'aurion-aios-builder', '.mcp.json'), 'utf8');
if (!packagedMcp.includes(expectedUrl) || packagedMcp.includes('127.0.0.1')) {
  throw new Error('Refusing to package a client that does not exclusively reference the hosted Remote MCP.');
}

const pluginZip = path.join(releases, 'aurion-aios-builder-plugin.zip');
const skillZips = skillNames.map((skillName) => path.join(releases, `${skillName}.skill.zip`));
const oneClickZip = path.join(releases, 'aurion-aios-one-click-install.zip');
const macUpdaterZip = path.join(releases, 'aurion-aios-plugin-updater-macos.zip');
const macUpdaterV2CompatZip = path.join(releases, 'aurion-aios-plugin-updater-macos-v2.zip');
const macUpdaterV3CompatZip = path.join(releases, 'aurion-aios-plugin-updater-macos-v3.zip');
const macUpdaterV4CompatZip = path.join(releases, 'aurion-aios-plugin-updater-macos-v4.zip');
const macUpdaterVersionedZip = path.join(releases, 'aurion-aios-plugin-updater-macos-v5.zip');
const windowsUpdaterZip = path.join(releases, 'aurion-aios-plugin-updater-windows.zip');
const windowsUpdaterV2CompatZip = path.join(releases, 'aurion-aios-plugin-updater-windows-v2.zip');
const windowsUpdaterV3CompatZip = path.join(releases, 'aurion-aios-plugin-updater-windows-v3.zip');
const windowsUpdaterVersionedZip = path.join(releases, 'aurion-aios-plugin-updater-windows-v4.zip');
const releaseFiles = [pluginZip, ...skillZips, oneClickZip, macUpdaterZip, macUpdaterV2CompatZip, macUpdaterV3CompatZip, macUpdaterV4CompatZip, macUpdaterVersionedZip, windowsUpdaterZip, windowsUpdaterV2CompatZip, windowsUpdaterV3CompatZip, windowsUpdaterVersionedZip];
await Promise.all(releaseFiles.map((file) => rm(file, { force: true })));

await run('zip', ['-qry', pluginZip, 'aurion-aios-builder'], path.dirname(pluginSource));
for (const [index, skillName] of skillNames.entries()) {
  await run('zip', ['-qry', skillZips[index], skillName], path.join(packageRoot, 'skills'));
}
await run('zip', ['-qry', oneClickZip, path.basename(staging)], releases);
await run('zip', ['-qry', macUpdaterZip, path.basename(macUpdaterStaging)], releases);
await copyFile(macUpdaterZip, macUpdaterV2CompatZip);
await copyFile(macUpdaterZip, macUpdaterV3CompatZip);
await copyFile(macUpdaterZip, macUpdaterV4CompatZip);
await copyFile(macUpdaterZip, macUpdaterVersionedZip);
await run('zip', ['-qry', windowsUpdaterZip, path.basename(windowsUpdaterStaging)], releases);
await copyFile(windowsUpdaterZip, windowsUpdaterV2CompatZip);
await copyFile(windowsUpdaterZip, windowsUpdaterV3CompatZip);
await copyFile(windowsUpdaterZip, windowsUpdaterVersionedZip);

const checksumLines = [];
for (const file of releaseFiles) {
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
console.log(`Created ${macUpdaterZip}`);
console.log(`Created ${macUpdaterVersionedZip}`);
console.log(`Created ${windowsUpdaterZip}`);
