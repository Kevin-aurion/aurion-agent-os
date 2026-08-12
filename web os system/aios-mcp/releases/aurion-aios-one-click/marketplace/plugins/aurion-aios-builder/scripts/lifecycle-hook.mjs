#!/usr/bin/env node

import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { stateFileName, transitionLifecycle } from './lifecycle-hook-core.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      return async () => {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
      const age = await stat(lockPath)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0);
      if (age > STALE_LOCK_MS) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  return null;
}

async function loadState(statePath) {
  try {
    const info = await stat(statePath);
    if (!info.isFile() || info.size > MAX_STATE_BYTES) return null;
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function saveState(statePath, state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, statePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await rm(statePath, { force: true });
    await rename(temporary, statePath);
  }
  await chmod(statePath, 0o600);
}

async function run() {
  const input = await readStdin();
  const pluginData = process.env.CLAUDE_PLUGIN_DATA?.trim();
  const filename = stateFileName(input?.session_id);
  if (!input || !pluginData || !filename) return {};

  const stateDirectory = path.resolve(pluginData, 'lifecycle-state');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700).catch(() => {});
  const statePath = path.join(stateDirectory, filename);
  const lockPath = `${statePath}.lock`;
  const release = await acquireLock(lockPath);
  if (!release) return {};

  try {
    const previous = await loadState(statePath);
    const result = transitionLifecycle(previous, input);
    if (result.state) await saveState(statePath, result.state);
    return result.output;
  } finally {
    await release();
  }
}

run()
  .then((output) => process.stdout.write(`${JSON.stringify(output ?? {})}\n`))
  .catch(() => process.stdout.write('{}\n'));
