export type Tone = 'positive' | 'warning' | 'danger' | 'info' | 'neutral';

const POSITIVE = new Set(['ACTIVE', 'CONFIRMED', 'PASSED', 'HEALTHY', 'VALIDATED', 'READY']);
const WARNING = new Set(['PAUSED', 'AWAITING_FDE', 'AWAITING_USER_CONFIRM', 'PENDING_UNDERSTANDING', 'SANDBOX', 'CANARY']);
const DANGER = new Set(['FAILED', 'REJECTED', 'ERROR', 'BLOCKED', 'ARCHIVED']);

export function statusTone(status: string | null | undefined): Tone {
  const normalized = String(status ?? '').toUpperCase();
  if (POSITIVE.has(normalized)) return 'positive';
  if (WARNING.has(normalized)) return 'warning';
  if (DANGER.has(normalized)) return 'danger';
  if (normalized) return 'info';
  return 'neutral';
}

export function engineLabel(engine: string | null | undefined): string {
  return ({ CLAUDE_CODE: 'Claude Code', CODEX: 'Codex', GROK: 'Grok' } as Record<string, string>)[String(engine)] ?? '自動配置';
}

export function canSaveEnginePair(execute: string, verify: string | null): boolean {
  return Boolean(execute) && (!verify || execute !== verify);
}

export function isKnowledgePilotReady(status: {
  knowledgeIndex: { ready: boolean };
  langflow: { healthy: boolean };
} | null | undefined): boolean {
  return Boolean(status?.knowledgeIndex.ready && status?.langflow.healthy);
}

export function formatRuntimeDuration(durationMs: number | null | undefined): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '—';
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))} ms`;
  return `${(durationMs / 1_000).toFixed(2)} s`;
}

export const studioSections = [
  { href: '/studio', label: '總覽', group: '工作空間' },
  { href: '/studio/agents', label: 'Agent', group: '工作空間' },
  { href: '/studio/models', label: '模型', group: '資源配置' },
  { href: '/studio/tools', label: 'Tool 與 MCP', group: '資源配置' },
  { href: '/studio/knowledge', label: 'Knowledge', group: '資源配置' },
  { href: '/studio/skills', label: 'Skill', group: '資源配置' },
  { href: '/studio/graph', label: 'Graph 工程', group: '治理與執行' },
  { href: '/studio/runtime', label: 'Deployment', group: '治理與執行' },
] as const;
