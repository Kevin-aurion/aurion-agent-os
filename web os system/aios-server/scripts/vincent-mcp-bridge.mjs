#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';

export const VINCENT_MCP_URL = 'https://vincent.pinnovabiotech.com.tw/api/mcp';
export const VINCENT_ISSUER = 'https://aurion-aios.lazyoffice.app';
export const VINCENT_SUBJECT = 'aios-employee:vincent-query-consultant';
export const VINCENT_SCOPE = 'knowledge.search agent.job.read';
export const VINCENT_TOKEN_TTL_SECONDS = 10 * 60;
export const VINCENT_KEYCHAIN_SERVICE = 'app.aurion.aios.vincent.hs256';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proxyBin = path.join(serverRoot, 'node_modules', 'mcp-remote', 'dist', 'proxy.js');

export function buildProxyArgs(headerPath) {
  return [
    proxyBin,
    VINCENT_MCP_URL,
    '--transport',
    'http-only',
    '--header-file',
    headerPath,
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
        VINCENT_SUBJECT,
        '-s',
        VINCENT_KEYCHAIN_SERVICE,
        '-w',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    throw new Error(
      'Vincent MCP HS256 shared secret is not installed in macOS Keychain. Run scripts/install-vincent-mcp-credential.command first.',
    );
  }
}

function privateRuntimeDir() {
  const dir = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Aurion AIOS',
    'mcp-runtime',
    'vincent-hs256',
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export async function signVincentToken(secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  return new SignJWT({ mcp_scope: VINCENT_SCOPE })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(VINCENT_ISSUER)
    .setSubject(VINCENT_SUBJECT)
    .setAudience(VINCENT_MCP_URL)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + VINCENT_TOKEN_TTL_SECONDS)
    .sign(new TextEncoder().encode(secret));
}

async function main() {
  const secret = readSecretFromKeychain();
  if (!secret) throw new Error('Vincent MCP HS256 shared secret in Keychain is empty.');
  const token = await signVincentToken(secret);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'aurion-vincent-mcp-'));
  chmodSync(tempDir, 0o700);
  const headerPath = path.join(tempDir, 'authorization.headers');
  writeFileSync(headerPath, `Authorization: Bearer ${token}\n`, { mode: 0o600 });

  let cleaned = false;
  let recycleTimer;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (recycleTimer) clearTimeout(recycleTimer);
    rmSync(tempDir, { recursive: true, force: true });
  };

  const child = spawn(process.execPath, buildProxyArgs(headerPath), {
    cwd: serverRoot,
    env: {
      ...process.env,
      MCP_REMOTE_CONFIG_DIR: privateRuntimeDir(),
      NO_PROXY: 'localhost,127.0.0.1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.on('data', (chunk) => {
    const safe = String(chunk).split(secret).join('[REDACTED]').split(token).join('[REDACTED]');
    process.stderr.write(safe);
  });

  const stop = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // Process may already be gone.
    }
  };

  // Recycle two minutes before token expiry. The next broker call reconnects
  // and this wrapper signs a fresh short-lived JWT from Keychain.
  recycleTimer = setTimeout(
    () => stop('SIGTERM'),
    (VINCENT_TOKEN_TTL_SECONDS - 120) * 1000,
  );
  recycleTimer.unref();

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
