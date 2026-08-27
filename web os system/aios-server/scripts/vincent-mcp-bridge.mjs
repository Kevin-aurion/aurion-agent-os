#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VINCENT_MCP_URL = 'https://vincent.pinnovabiotech.com.tw/api/mcp';
export const VINCENT_CLIENT_ID = '3db2b7a3-9fcf-4cf4-9afc-d30d29fbe801';
export const VINCENT_CALLBACK_PORT = 3335;
export const VINCENT_KEYCHAIN_SERVICE = 'app.aurion.aios.vincent.read';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proxyBin = path.join(serverRoot, 'node_modules', 'mcp-remote', 'dist', 'proxy.js');

export function buildProxyArgs(clientInfoPath) {
  return [
    proxyBin,
    VINCENT_MCP_URL,
    String(VINCENT_CALLBACK_PORT),
    '--host',
    'localhost',
    '--callback-path',
    '/oauth/callback',
    '--transport',
    'http-only',
    '--static-oauth-client-info',
    `@${clientInfoPath}`,
    '--silent',
  ];
}

function readSecretFromKeychain() {
  try {
    return execFileSync(
      '/usr/bin/security',
      [
        'find-generic-password',
        '-a',
        VINCENT_CLIENT_ID,
        '-s',
        VINCENT_KEYCHAIN_SERVICE,
        '-w',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    throw new Error(
      'Vincent MCP credential is not installed in macOS Keychain. Run scripts/install-vincent-mcp-credential.command first.',
    );
  }
}

async function assertCallbackPortAvailable() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => {
      reject(
        new Error(
          `OAuth callback port ${VINCENT_CALLBACK_PORT} is already in use; refusing to change the registered redirect URI.`,
        ),
      );
    });
    server.listen(VINCENT_CALLBACK_PORT, 'localhost', () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function privateAuthDir() {
  const dir = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Aurion AIOS',
    'mcp-auth',
    'vincent-read',
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

async function main() {
  await assertCallbackPortAvailable();
  const secret = readSecretFromKeychain();
  if (!secret) throw new Error('Vincent MCP credential in Keychain is empty.');

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'aurion-vincent-mcp-'));
  chmodSync(tempDir, 0o700);
  const clientInfoPath = path.join(tempDir, 'oauth-client.json');
  writeFileSync(
    clientInfoPath,
    JSON.stringify({ client_id: VINCENT_CLIENT_ID, client_secret: secret }),
    { mode: 0o600 },
  );

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(tempDir, { recursive: true, force: true });
  };

  const child = spawn(process.execPath, buildProxyArgs(clientInfoPath), {
    cwd: serverRoot,
    env: {
      ...process.env,
      MCP_REMOTE_CONFIG_DIR: privateAuthDir(),
      NO_PROXY: 'localhost,127.0.0.1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.on('data', (chunk) => {
    // mcp-remote protocol stays on stdout. Keep diagnostics on stderr and make
    // sure an upstream error can never echo the confidential client secret.
    const safe = String(chunk).split(secret).join('[REDACTED]');
    process.stderr.write(safe);
  });

  const stop = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // Process may already be gone.
    }
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('exit', cleanup);

  child.once('error', (error) => {
    cleanup();
    process.stderr.write(`Vincent MCP bridge failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

