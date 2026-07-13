// Preflight doctor: verifies the local environment is ready to run AIOS.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { config } from '../config.js';

const pexec = promisify(execFile);
let failures = 0;

function line(ok: boolean, label: string, detail = '') {
  const mark = ok ? '✓' : '✗';
  if (!ok) failures++;
  console.log(`${mark} ${label}${detail ? '  — ' + detail : ''}`);
}

function tcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(2000);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

async function cli(path: string, label: string) {
  try {
    const { stdout } = await pexec(path, ['--version'], { timeout: 5000 });
    line(true, label, stdout.trim().split('\n')[0]);
  } catch {
    line(false, label, `not found at ${path}`);
  }
}

async function main() {
  console.log('AIOS doctor\n───────────');
  line(Buffer.from(config.encryptionKey, 'hex').length === 32, 'AIOS_ENCRYPTION_KEY (32 bytes)');
  line(config.jwtSecret.length >= 32, 'AIOS_JWT_SECRET set');

  const dbUrl = new URL(config.databaseUrl);
  line(await tcpOpen(dbUrl.hostname, Number(dbUrl.port || 5432)), `Postgres reachable (${dbUrl.host})`, 'run: docker compose up -d');
  const redisUrl = new URL(config.redisUrl);
  line(await tcpOpen(redisUrl.hostname, Number(redisUrl.port || 6379)), `Redis reachable (${redisUrl.host})`);

  await cli(config.engines.claudePath, 'claude CLI');
  await cli(config.engines.codexPath, 'codex CLI');

  console.log('\nIntegrations configured (.env):');
  line(!!config.microsoft.clientId, 'Microsoft 365', config.microsoft.clientId ? '' : 'MS_CLIENT_ID empty');
  line(!!config.google.clientId, 'Google', config.google.clientId ? '' : 'GOOGLE_CLIENT_ID empty');
  line(!!config.line.accessToken, 'LINE', config.line.accessToken ? '' : 'LINE_CHANNEL_ACCESS_TOKEN empty');

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll core checks passed.');
  process.exit(failures ? 1 : 0);
}

main();
