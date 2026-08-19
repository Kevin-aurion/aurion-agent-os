import type { Tone } from '../presentation.js';
import type { GraphArtifactKind, NodeCompileStatus, PaletteGroup, RiskLevel } from './types';

/** Canonical nav entry for Graph Workbench (also registered in studioSections). */
export const studioGraphSection = {
  href: '/studio/graph',
  label: 'Graph 工程',
  group: '治理與執行',
} as const;

export function canAccessGraphWorkbench(role?: string | null): boolean {
  return role === 'OWNER' || role === 'TRAINER';
}

export function governanceSaveCopy(): string {
  return 'Save ≠ Deploy：儲存不可變 Source 不是 Production 部署。Production 仍須 Runtime 驗證、Eval、FDE、Canary/Stable。';
}

export function artifactKindLabel(kind: GraphArtifactKind | string): string {
  if (kind === 'source') return 'Source GraphSpec';
  if (kind === 'langflow-native') return 'Langflow Native';
  return 'Unknown artifact';
}

export function artifactKindTone(kind: GraphArtifactKind | string): Tone {
  if (kind === 'langflow-native') return 'positive';
  if (kind === 'source') return 'info';
  return 'neutral';
}

/**
 * Source artifacts are never deployable to Langflow, even if a flag is wrong.
 * Only langflow-native + explicit langflowDeployable counts.
 */
export function isLangflowDeployableArtifact(item: {
  artifactKind?: string | null;
  langflowDeployable?: boolean | null;
}): boolean {
  if (item.artifactKind !== 'langflow-native') return false;
  return item.langflowDeployable === true;
}

export function riskTone(risk: RiskLevel | string | null | undefined): Tone {
  const r = String(risk ?? '').toUpperCase();
  if (r === 'HIGH') return 'danger';
  if (r === 'MEDIUM') return 'warning';
  if (r === 'LOW') return 'info';
  return 'neutral';
}

export function compileStatusTone(status: NodeCompileStatus | string | null | undefined): Tone {
  if (status === 'mapped') return 'positive';
  if (status === 'unsupported') return 'danger';
  return 'neutral';
}

export function paletteGroupLabel(group: PaletteGroup | string): string {
  const map: Record<string, string> = {
    input_output: 'Input / Output',
    reasoning: 'Reasoning',
    tool: 'Tool',
    governance: 'Governance',
    control: 'Control',
    composition: 'Composition',
  };
  return map[group] ?? group;
}

export const PALETTE_GROUP_ORDER: PaletteGroup[] = [
  'input_output',
  'reasoning',
  'tool',
  'governance',
  'control',
  'composition',
];

export function nodeKindBadge(kind: string): { label: string; tone: Tone } {
  if (kind.startsWith('control.')) return { label: 'Control', tone: 'info' };
  if (kind.startsWith('tool.')) return { label: 'Tool', tone: 'warning' };
  if (kind.startsWith('gateway.')) return { label: 'Reasoning', tone: 'info' };
  if (kind === 'approval.checkpoint') return { label: 'Governance', tone: 'warning' };
  if (kind === 'subgraph') return { label: 'Composition', tone: 'info' };
  if (kind === 'input' || kind === 'output') return { label: 'I/O', tone: 'neutral' };
  return { label: kind, tone: 'neutral' };
}

/**
 * Action-note copy after Compile → Native succeeds.
 * Always uses a short immutable compiled artifact id + ellipsis.
 * Never includes digest — server-wide redactor can conservatively mask
 * 12-char digest prefixes, producing a confusing `[REDACTED...]` success message.
 */
export function formatCompileNativeActionNote(compiledId: string): string {
  const shortId = compiledId.slice(0, 10);
  return `Langflow native artifact stored · ${shortId}…`;
}
