/**
 * Shared helpers for Graph Engineering v2 tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphSpecV2 } from '../../../src/graph/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(__dirname, 'fixtures');

export function loadMinCatalogue(): unknown {
  const raw = readFileSync(join(FIXTURES, 'langflow-catalogue-min.json'), 'utf8');
  return JSON.parse(raw) as unknown;
}

export function echoGraph(overrides?: Partial<GraphSpecV2>): GraphSpecV2 {
  const base: GraphSpecV2 = {
    schemaVersion: 'aios.flow-graph/2',
    id: 'g_echo',
    name: 'echo',
    revision: 1,
    stateSchema: { type: 'object', properties: {}, additionalProperties: true },
    entryNodeId: 'n_start',
    exitNodeIds: ['n_end'],
    nodes: [
      {
        id: 'n_start',
        kind: 'control.start',
        label: 'Start',
        position: { x: 100, y: 100 },
        config: {},
      },
      {
        id: 'n_end',
        kind: 'control.end',
        label: 'End',
        position: { x: 400, y: 100 },
        config: {},
      },
    ],
    edges: [
      {
        id: 'e_start_end',
        kind: 'default',
        source: 'n_start',
        target: 'n_end',
      },
    ],
  };
  return { ...base, ...overrides, nodes: overrides?.nodes ?? base.nodes, edges: overrides?.edges ?? base.edges };
}

export function linearIoGraph(): GraphSpecV2 {
  return {
    schemaVersion: 'aios.flow-graph/2',
    id: 'g_io',
    name: 'input-output',
    revision: 1,
    stateSchema: { type: 'object', properties: {} },
    entryNodeId: 'n_in',
    exitNodeIds: ['n_out'],
    nodes: [
      {
        id: 'n_in',
        kind: 'input',
        label: 'Input',
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: 'n_out',
        kind: 'output',
        label: 'Output',
        position: { x: 300, y: 0 },
        config: {},
      },
    ],
    edges: [{ id: 'e1', kind: 'default', source: 'n_in', target: 'n_out' }],
  };
}

export function approvalGatedGraph(): GraphSpecV2 {
  return {
    schemaVersion: 'aios.flow-graph/2',
    id: 'g_gated',
    name: 'gated',
    revision: 1,
    stateSchema: { type: 'object', properties: {} },
    entryNodeId: 'n_in',
    exitNodeIds: ['n_out'],
    nodes: [
      {
        id: 'n_in',
        kind: 'input',
        label: 'In',
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: 'n_cp',
        kind: 'approval.checkpoint',
        label: 'Approve',
        position: { x: 200, y: 0 },
        config: {
          reason: 'send reply',
          risk: 'high',
          authority: 'AIOS',
          emits: 'approval.required',
          resumeRequires: 'aios.approvalRequest.APPROVED',
        },
      },
      {
        id: 'n_gate',
        kind: 'tool.gated',
        label: 'Send',
        position: { x: 400, y: 0 },
        tool: 'mcp:gmail:gmail_send_reply',
        config: {},
      },
      {
        id: 'n_out',
        kind: 'output',
        label: 'Out',
        position: { x: 600, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', kind: 'default', source: 'n_in', target: 'n_cp' },
      { id: 'e2', kind: 'default', source: 'n_cp', target: 'n_gate' },
      { id: 'e3', kind: 'default', source: 'n_gate', target: 'n_out' },
    ],
  };
}

let passed = 0;
let failed = 0;
let blocked = 0;

export function pass(label: string, detail = ''): void {
  passed += 1;
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

export function fail(label: string, detail: string): void {
  failed += 1;
  process.exitCode = 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

export function check(cond: unknown, label: string, detailOnFail: string): void {
  if (cond) pass(label);
  else fail(label, detailOnFail);
}

export function blockedMsg(label: string, detail: string): void {
  blocked += 1;
  console.log(`BLOCKED  ${label} — ${detail}`);
}

export function summary(name: string): { passed: number; failed: number; blocked: number } {
  console.log(`\n── ${name} summary: ${passed} passed, ${failed} failed, ${blocked} blocked ──`);
  return { passed, failed, blocked };
}

export function resetCounters(): void {
  passed = 0;
  failed = 0;
  blocked = 0;
}
