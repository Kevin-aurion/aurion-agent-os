/**
 * Pure self-test: device-bound workflow steps require agentId before save.
 * Run: npx tsx src/lib/devices.device-bound-agent.selftest.ts
 */
import { deviceBoundStepsAgentErrors, requirementForStep } from './devices';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function main() {
  // requirement helper sanity
  assert(requirementForStep({ type: 'COMPUTER_CONTROL' }) === 'computer_use', 'cc req');
  assert(
    requirementForStep({ type: 'TOOL', toolName: 'device-mcp:line-desktop:send_message_manual' }) ===
      'line_desktop',
    'line req',
  );
  assert(requirementForStep({ type: 'DO' }) === null, 'do no req');

  // With agentId → no errors
  const withAgent = deviceBoundStepsAgentErrors(
    [
      { localId: 'a', type: 'COMPUTER_CONTROL', deviceId: 'dev-1' },
      {
        localId: 'b',
        type: 'TOOL',
        toolName: 'device-mcp:line-desktop:send_message_manual',
        deviceId: 'dev-2',
      },
    ],
    'agent-1',
  );
  assert(Object.keys(withAgent).length === 0, 'agent present must allow');

  // Missing agentId + device-bound steps → reject
  const noAgent = deviceBoundStepsAgentErrors(
    [
      { localId: 'cc', type: 'COMPUTER_CONTROL', deviceId: 'dev-1' },
      {
        localId: 'line',
        type: 'TOOL',
        toolName: 'device-mcp:line-desktop:send_message_manual',
        deviceId: 'dev-2',
      },
      { localId: 'do', type: 'DO' },
    ],
    undefined,
  );
  assert(noAgent.cc, 'cc rejected without agent');
  assert(noAgent.line, 'line rejected without agent');
  assert(!noAgent.do, 'non-device step not flagged');
  assert(noAgent.cc.includes('agentId'), 'error mentions agentId');

  // Empty / whitespace agentId treated as missing
  const blank = deviceBoundStepsAgentErrors(
    [{ localId: 'cc2', type: 'COMPUTER_CONTROL', deviceId: 'x' }],
    '   ',
  );
  assert(blank.cc2, 'blank agentId rejected');

  // Non-device steps only + no agent → OK
  const plain = deviceBoundStepsAgentErrors(
    [
      { localId: 'd', type: 'DO' },
      { localId: 't', type: 'TOOL', toolName: 'scan_invoices' },
    ],
    null,
  );
  assert(Object.keys(plain).length === 0, 'plain steps without agent OK');

  console.log('PASS devices.device-bound-agent.selftest (5 cases)');
}

main();
