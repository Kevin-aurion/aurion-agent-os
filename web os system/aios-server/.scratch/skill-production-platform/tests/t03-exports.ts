/**
 * Ticket 03 — codexmcp export shape unchanged.
 * Run: npx tsx .scratch/skill-production-platform/tests/t03-exports.ts
 * Does NOT spawn Codex.
 */
import * as codexmcp from '../../../src/lib/codexmcp.js';
import type { McpClient } from '../../../src/lib/codexmcp.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const EXPECTED_CU = [
  'list_apps',
  'get_app_state',
  'click',
  'perform_secondary_action',
  'set_value',
  'select_text',
  'scroll',
  'drag',
  'press_key',
  'type_text',
] as const;

const EXPECTED_ES = [
  'event_stream_start',
  'event_stream_status',
  'event_stream_stop',
] as const;

function main() {
  assert(typeof codexmcp.connectComputerUse === 'function', 'connectComputerUse is function');
  assert(codexmcp.connectComputerUse.length === 0, 'connectComputerUse arity 0');

  assert(typeof codexmcp.connectEventStream === 'function', 'connectEventStream is function');
  assert(codexmcp.connectEventStream.length === 0, 'connectEventStream arity 0');

  assert(typeof codexmcp.assertToolsPresent === 'function', 'assertToolsPresent is function');
  assert(codexmcp.assertToolsPresent.length === 2, 'assertToolsPresent arity 2');

  assert(
    Array.isArray(codexmcp.COMPUTER_USE_TOOLS) &&
      deepEqual([...codexmcp.COMPUTER_USE_TOOLS], [...EXPECTED_CU]),
    `COMPUTER_USE_TOOLS mismatch: ${JSON.stringify(codexmcp.COMPUTER_USE_TOOLS)}`,
  );
  assert(
    Array.isArray(codexmcp.EVENT_STREAM_TOOLS) &&
      deepEqual([...codexmcp.EVENT_STREAM_TOOLS], [...EXPECTED_ES]),
    `EVENT_STREAM_TOOLS mismatch: ${JSON.stringify(codexmcp.EVENT_STREAM_TOOLS)}`,
  );

  // Type-only import of McpClient must compile (this file is typechecked via tsc of consumers;
  // at runtime we just prove the module loads).
  const _typeProbe: McpClient | null = null;
  void _typeProbe;

  console.log('T03 EXPORTS OK');
  process.exit(0);
}

main();
