import { execFile } from 'node:child_process';
import { access, chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(packageRoot, 'dist', 'index.js');
const label = 'app.aurion.aios-remote-mcp';
const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
const logs = path.join(os.homedir(), 'Library', 'Logs');
const plist = path.join(launchAgents, `${label}.plist`);

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

await access(entrypoint);
await mkdir(launchAgents, { recursive: true });
await mkdir(logs, { recursive: true });

const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(entrypoint)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(packageRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIOS_MCP_TRANSPORT</key><string>http</string>
    <key>AIOS_MCP_HTTP_AUTH</key><string>oauth</string>
    <key>AIOS_MCP_HTTP_PORT</key><string>8701</string>
    <key>AIOS_MCP_PUBLIC_URL</key><string>https://aurion-aios-mcp.lazyoffice.app/mcp</string>
    <key>AIOS_MCP_PROFILE</key><string>builder</string>
    <key>AIOS_MCP_BASE_URL</key><string>http://127.0.0.1:8700</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'aurion-aios-remote-mcp.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'aurion-aios-remote-mcp.stderr.log'))}</string>
</dict>
</plist>
`;

const temporary = `${plist}.${process.pid}.tmp`;
await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, plist);

const domain = `gui/${process.getuid()}`;
await exec('launchctl', ['bootout', domain, plist]).catch(() => {});
await exec('launchctl', ['bootstrap', domain, plist]);
await exec('launchctl', ['kickstart', '-k', `${domain}/${label}`]);

let healthy = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    const response = await fetch('http://127.0.0.1:8701/healthz');
    if (response.ok) {
      healthy = true;
      break;
    }
  } catch {
    // launchd may need a short moment after kickstart before the socket is ready.
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!healthy) throw new Error('Remote MCP LaunchAgent started but loopback health did not become ready');

console.log(`Installed and started ${label}`);
console.log('Remote MCP health verified: http://127.0.0.1:8701/healthz');
