import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aurionRoot = path.resolve(packageRoot, '../..');
const updater = path.join(aurionRoot, 'update-aios-plugins.sh');
const bundledMarketplace = path.join(packageRoot, 'installers', 'updater', 'marketplace');

async function makeExecutable(file, body) {
  await writeFile(file, `#!/bin/bash\nset -u\n${body}\n`, 'utf8');
  await chmod(file, 0o755);
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const { input, ...spawnOptions } = options;
    const child = spawn(command, args, spawnOptions);
    let stdout = '';
    let stderr = '';
    if (child.stdin) child.stdin.end(input ?? '');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('click updater installs missing Claude and Codex plugins before checking MCP', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aurion-updater-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fakeBin = path.join(tempRoot, 'bin');
  const stateDir = path.join(tempRoot, 'state');
  const managedMarketplace = path.join(tempRoot, 'managed-marketplace');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await makeExecutable(path.join(fakeBin, 'curl'), 'printf "401"');
  await makeExecutable(path.join(fakeBin, 'python3'), 'exec /usr/bin/python3 "$@"');
  await writeFile(path.join(tempRoot, 'cachebuster.py'), '# test helper\n', 'utf8');

  await makeExecutable(path.join(fakeBin, 'claude'), `
printf '%s\\n' "$*" >> "$AIOS_FAKE_STATE_DIR/claude.log"
case "$*" in
  "plugin list")
    if [ -f "$AIOS_FAKE_STATE_DIR/claude-installed" ]; then
      printf 'aurion-aios-builder@aurion-aios-updater installed, enabled\\n'
    fi
    ;;
  "plugin marketplace list")
    if [ -f "$AIOS_FAKE_STATE_DIR/claude-marketplace" ]; then
      printf 'aurion-aios-updater\\n'
    fi
    ;;
  plugin\\ marketplace\\ add*) touch "$AIOS_FAKE_STATE_DIR/claude-marketplace" ;;
  plugin\\ install*) touch "$AIOS_FAKE_STATE_DIR/claude-installed" ;;
  mcp\\ get*) printf 'Status: Connected\\n' ;;
esac
exit 0`);

  await makeExecutable(path.join(fakeBin, 'codex'), `
printf '%s\\n' "$*" >> "$AIOS_FAKE_STATE_DIR/codex.log"
case "$*" in
  "plugin list")
    if [ -f "$AIOS_FAKE_STATE_DIR/codex-installed" ]; then
      printf 'aurion-aios-builder@aurion-aios-updater  installed, enabled  1.8.2  /tmp/plugin\\n'
    fi
    ;;
  "plugin marketplace list --json")
    if [ -f "$AIOS_FAKE_STATE_DIR/codex-marketplace" ]; then
      printf '{"marketplaces":[{"name":"aurion-aios-updater"}]}\\n'
    else
      printf '{"marketplaces":[]}\\n'
    fi
    ;;
  plugin\\ marketplace\\ add*) touch "$AIOS_FAKE_STATE_DIR/codex-marketplace" ;;
  plugin\\ add*) touch "$AIOS_FAKE_STATE_DIR/codex-installed" ;;
  "mcp list") printf 'aurion_aios  https://example.invalid/mcp  enabled  OAuth\\n' ;;
esac
exit 0`);

  const result = await run('/bin/bash', [updater], {
    cwd: aurionRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      AIOS_FAKE_STATE_DIR: stateDir,
      AURION_BUNDLED_MARKETPLACE: bundledMarketplace,
      AURION_MANAGED_MARKETPLACE: managedMarketplace,
      AURION_CACHEBUSTER_HELPER: path.join(tempRoot, 'cachebuster.py'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  await stat(path.join(managedMarketplace, '.claude-plugin', 'marketplace.json'));
  await stat(path.join(managedMarketplace, '.agents', 'plugins', 'marketplace.json'));
  await stat(path.join(managedMarketplace, 'plugins', 'aurion-aios-builder', '.mcp.json'));

  const claudeLog = await readFile(path.join(stateDir, 'claude.log'), 'utf8');
  assert.match(claudeLog, /plugin marketplace add --scope user .*managed-marketplace/);
  assert.match(claudeLog, /plugin install --yes --scope user aurion-aios-builder@aurion-aios-updater/);
  assert.doesNotMatch(claudeLog, /mcp login/);

  const codexLog = await readFile(path.join(stateDir, 'codex.log'), 'utf8');
  assert.match(codexLog, /plugin marketplace add .*managed-marketplace/);
  assert.match(codexLog, /plugin add aurion-aios-builder@aurion-aios-updater/);
  assert.doesNotMatch(codexLog, /mcp login/);
  assert.match(result.stdout, /Plugin 安裝／更新與 MCP 驗證全部完成/);
});

test('macOS launcher reads a non-executable nested updater through system bash', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aurion-launcher-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const launcher = path.join(tempRoot, 'Aurion AIOS Updater.command');
  const resources = path.join(tempRoot, 'Aurion AIOS Updater.app', 'Contents', 'Resources');
  const updaterScript = path.join(resources, 'update-aios-plugins.sh');
  const pluginSource = path.join(resources, 'marketplace', 'plugins', 'aurion-aios-builder');
  await mkdir(pluginSource, { recursive: true });
  await writeFile(
    launcher,
    await readFile(path.join(packageRoot, 'installers', 'updater', 'macos', 'Aurion AIOS Updater.command')),
  );
  await chmod(launcher, 0o755);
  await writeFile(updaterScript, '#!/bin/bash\nprintf "nested updater reached\\n"\n', 'utf8');
  await chmod(updaterScript, 0o644);

  const result = await run('/bin/bash', [launcher], {
    env: { ...process.env, TERM: 'xterm' },
    input: '\n',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /nested updater reached/);
  assert.match(result.stdout, /全部完成/);
});

test('Codex versioned cache install migrates to the packaged marketplace safely', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.homedir(), '.aurion-local-marketplace-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fakeBin = path.join(tempRoot, 'bin');
  const stateDir = path.join(tempRoot, 'state');
  const managedMarketplace = path.join(tempRoot, 'managed-marketplace');
  const localPlugin = path.join(tempRoot, '.codex', 'plugins', 'cache', 'claude-cowork', 'aurion-aios-builder', '1.5.1');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(localPlugin, { recursive: true });
  await writeFile(path.join(localPlugin, 'cache-marker.txt'), 'Codex owns this cache\n', 'utf8');

  await makeExecutable(path.join(fakeBin, 'curl'), 'printf "401"');
  await makeExecutable(path.join(fakeBin, 'python3'), 'exec /usr/bin/python3 "$@"');
  await writeFile(path.join(tempRoot, 'cachebuster.py'), '# test helper\n', 'utf8');
  await makeExecutable(path.join(fakeBin, 'codex'), `
printf '%s\\n' "$*" >> "$AIOS_FAKE_STATE_DIR/codex.log"
case "$*" in
  "plugin list --json")
    if [ -f "$AIOS_FAKE_STATE_DIR/managed-installed" ]; then
      printf '%s\\n' '${JSON.stringify({ installed: [{
        pluginId: 'aurion-aios-builder@aurion-aios-updater',
        name: 'aurion-aios-builder',
        marketplaceName: 'aurion-aios-updater',
        installed: true,
        enabled: true,
        source: { source: 'local', path: path.join(managedMarketplace, 'plugins', 'aurion-aios-builder') },
        marketplaceSource: { sourceType: 'local', source: managedMarketplace },
      }] })}'
    else
      printf '%s\\n' '${JSON.stringify({ installed: [{
        pluginId: 'aurion-aios-builder@claude-cowork',
        name: 'aurion-aios-builder',
        marketplaceName: 'claude-cowork',
        installed: true,
        enabled: true,
        source: { source: 'local', path: localPlugin },
        marketplaceSource: { sourceType: 'local', source: path.dirname(path.dirname(path.dirname(localPlugin))) },
      }] })}'
    fi
    ;;
  "plugin list")
    if [ -f "$AIOS_FAKE_STATE_DIR/managed-installed" ]; then
      printf 'aurion-aios-builder@aurion-aios-updater  installed, enabled  1.8.2  ${managedMarketplace}/plugins/aurion-aios-builder\\n'
    fi
    if [ ! -f "$AIOS_FAKE_STATE_DIR/legacy-removed" ]; then
      printf 'aurion-aios-builder@claude-cowork  installed, enabled  1.5.1  ${localPlugin}\\n'
    fi
    ;;
  "plugin marketplace list --json")
    if [ -f "$AIOS_FAKE_STATE_DIR/managed-marketplace" ]; then
      printf '{"marketplaces":[{"name":"aurion-aios-updater"}]}\\n'
    else
      printf '{"marketplaces":[]}\\n'
    fi
    ;;
  plugin\\ marketplace\\ add*) touch "$AIOS_FAKE_STATE_DIR/managed-marketplace" ;;
  "plugin add aurion-aios-builder@aurion-aios-updater") touch "$AIOS_FAKE_STATE_DIR/managed-installed" ;;
  "plugin remove aurion-aios-builder@claude-cowork") touch "$AIOS_FAKE_STATE_DIR/legacy-removed" ;;
  "plugin marketplace upgrade claude-cowork") exit 55 ;;
  "mcp list") printf 'aurion_aios  https://example.invalid/mcp  enabled  OAuth\\n' ;;
esac
exit 0`);

  const result = await run('/bin/bash', [updater, '--codex'], {
    cwd: aurionRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      AIOS_FAKE_STATE_DIR: stateDir,
      AURION_BUNDLED_MARKETPLACE: bundledMarketplace,
      AURION_MANAGED_MARKETPLACE: managedMarketplace,
      AURION_CACHEBUSTER_HELPER: path.join(tempRoot, 'cachebuster.py'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const codexLog = await readFile(path.join(stateDir, 'codex.log'), 'utf8');
  assert.doesNotMatch(codexLog, /plugin marketplace upgrade claude-cowork/);
  assert.match(codexLog, /plugin marketplace add .*managed-marketplace/);
  assert.match(codexLog, /plugin add aurion-aios-builder@aurion-aios-updater/);
  assert.match(codexLog, /plugin remove aurion-aios-builder@claude-cowork/);
  assert.match(result.stdout, /移除舊的 Codex Plugin 登錄：aurion-aios-builder@claude-cowork/);
  assert.equal(await readFile(path.join(localPlugin, 'cache-marker.txt'), 'utf8'), 'Codex owns this cache\n');
});

test('generic click updater bootstraps the official Codex CLI when no supported client exists', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aurion-updater-bootstrap-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fakeBin = path.join(tempRoot, 'bin');
  const stateDir = path.join(tempRoot, 'state');
  const managedMarketplace = path.join(tempRoot, 'managed-marketplace');
  const fakeInstaller = path.join(tempRoot, 'official-codex-install.sh');
  const codexTemplate = path.join(tempRoot, 'codex-template');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await makeExecutable(codexTemplate, `
printf '%s\\n' "$*" >> "$AIOS_FAKE_STATE_DIR/codex.log"
case "$*" in
  "plugin list --json")
    if [ -f "$AIOS_FAKE_STATE_DIR/plugin-installed" ]; then
      printf '%s\\n' '{"installed":[{"pluginId":"aurion-aios-builder@aurion-aios-updater","name":"aurion-aios-builder","marketplaceName":"aurion-aios-updater","installed":true,"enabled":true,"source":{"source":"local","path":"/tmp/managed/aurion-aios-builder"},"marketplaceSource":{"sourceType":"local","source":"/tmp/managed"}}]}'
    else
      printf '%s\\n' '{"installed":[]}'
    fi
    ;;
  "plugin list")
    if [ -f "$AIOS_FAKE_STATE_DIR/plugin-installed" ]; then
      printf 'aurion-aios-builder@aurion-aios-updater  installed, enabled  1.8.2  /tmp/managed/aurion-aios-builder\\n'
    fi
    ;;
  "plugin marketplace list --json")
    if [ -f "$AIOS_FAKE_STATE_DIR/marketplace-installed" ]; then
      printf '{"marketplaces":[{"name":"aurion-aios-updater"}]}\\n'
    else
      printf '{"marketplaces":[]}\\n'
    fi
    ;;
  plugin\\ marketplace\\ add*) touch "$AIOS_FAKE_STATE_DIR/marketplace-installed" ;;
  "plugin add aurion-aios-builder@aurion-aios-updater") touch "$AIOS_FAKE_STATE_DIR/plugin-installed" ;;
  "mcp list") printf 'aurion_aios  https://example.invalid/mcp  enabled  OAuth\\n' ;;
esac
exit 0`);
  await writeFile(
    fakeInstaller,
    `#!/bin/sh\nmkdir -p "$HOME/.local/bin"\ncp "$AIOS_FAKE_CODEX_TEMPLATE" "$HOME/.local/bin/codex"\nchmod 755 "$HOME/.local/bin/codex"\n`,
    'utf8',
  );
  await makeExecutable(path.join(fakeBin, 'curl'), `
case "$*" in
  *test.invalid/codex-install.sh*)
    output=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; output="$1"; break; fi
      shift
    done
    cp "$AIOS_FAKE_INSTALLER" "$output"
    ;;
  *) printf '401' ;;
esac
exit 0`);

  const result = await run('/bin/bash', [updater, '--no-auth'], {
    cwd: aurionRoot,
    env: {
      ...process.env,
      HOME: tempRoot,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      AIOS_FAKE_STATE_DIR: stateDir,
      AIOS_FAKE_INSTALLER: fakeInstaller,
      AIOS_FAKE_CODEX_TEMPLATE: codexTemplate,
      AURION_CODEX_INSTALL_URL: 'https://test.invalid/codex-install.sh',
      AURION_BUNDLED_MARKETPLACE: bundledMarketplace,
      AURION_MANAGED_MARKETPLACE: managedMarketplace,
      AURION_CACHEBUSTER_HELPER: path.join(tempRoot, 'missing-cachebuster.py'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  await stat(path.join(tempRoot, '.local', 'bin', 'codex'));
  assert.match(result.stdout, /官方 Codex CLI 已安裝完成/);
  assert.match(result.stdout, /Codex Plugin 已就緒/);
  assert.doesNotMatch(result.stdout + result.stderr, /找不到可處理的 Claude 或 Codex CLI/);
});

test('Windows VBS recovers a package opened from ZIP preview and Windows bootstraps Codex', async () => {
  const windowsRoot = path.join(packageRoot, 'installers', 'updater', 'windows');
  const vbs = await readFile(path.join(windowsRoot, 'Aurion AIOS Updater.vbs'), 'utf8');
  const powershell = await readFile(path.join(windowsRoot, 'Update-Aurion-AIOS-Plugins.ps1'), 'utf8');

  assert.match(vbs, /aurion-aios-plugin-updater-windows-v4\.zip/);
  assert.match(vbs, /Expand-Archive/);
  assert.match(vbs, /\.claude-plugin\\marketplace\.json/);
  assert.match(vbs, /\.agents\\plugins\\marketplace\.json/);
  assert.doesNotMatch(vbs, /package is incomplete\. Please download it again/i);
  assert.match(powershell, /https:\/\/chatgpt\.com\/codex\/install\.ps1/);
  assert.match(powershell, /Install-CodexWhenNoClient/);
  assert.match(powershell, /Programs\\OpenAI\\Codex\\bin/);
});
