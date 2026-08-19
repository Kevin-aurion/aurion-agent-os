import assert from 'node:assert/strict';
import { execCli } from '../../../src/engine/claude.js';

const controller = new AbortController();
const script = [
  "const {spawn}=require('node:child_process')",
  "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
  "console.log(child.pid)",
  "setInterval(()=>{},1000)",
].join(';');

const promise = execCli(process.execPath, ['-e', script], {
  timeoutMs: 10_000,
  signal: controller.signal,
});
setTimeout(() => controller.abort(), 250);
const result = await promise;
assert.equal(result.aborted, true);
const grandchildPid = Number(result.stdout.trim().split(/\s+/)[0]);
assert(Number.isInteger(grandchildPid) && grandchildPid > 1, 'grandchild pid was not captured');
await new Promise((resolve) => setTimeout(resolve, 100));
let alive = true;
try {
  process.kill(grandchildPid, 0);
} catch {
  alive = false;
}
assert.equal(alive, false, `grandchild ${grandchildPid} survived AbortSignal`);
console.log('✓ AbortSignal terminates the entire CLI process group');
