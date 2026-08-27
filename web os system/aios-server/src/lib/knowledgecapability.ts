/**
 * Knowledge Capability Contract (Phase 6 / Ticket 21).
 *
 * Runtime (Langflow) MUST NOT connect to Qdrant or embedding providers directly.
 * The only allowed entry for Runtime knowledge search is the AIOS Knowledge
 * Gateway (`POST /internal/knowledge/search`), which:
 *   1. verifies service identity + environment binding
 *   2. asserts ACL (same-agent, read-only scope)
 *   3. loads authoritative run/deployment context from DB
 *   4. calls memory recall for that agent only
 *   5. redacts every hit before return
 *
 * Classification / retention fields are contract metadata: any landed payload
 * must pass through redactSecrets / deepRedactSecrets. Defaults for Runtime
 * knowledge access: classification ceiling INTERNAL, scope 'read' only.
 *
 * Fail-closed: wrong scope, cross-agent, empty ids, wrong env → 403.
 */
import { errors } from './http.js';

export type KnowledgeClassification =
  | 'PUBLIC'
  | 'INTERNAL'
  | 'CONFIDENTIAL'
  | 'RESTRICTED';

/** Retention in days (contract field; enforcement is metadata + policy later). */
export type KnowledgeRetention = number;

/** Default Runtime knowledge access ceiling. */
export const DEFAULT_RUNTIME_CLASSIFICATION_CEILING: KnowledgeClassification =
  'INTERNAL';

/** Default Runtime knowledge scope — read only. */
export const DEFAULT_RUNTIME_KNOWLEDGE_SCOPE = 'read' as const;

export type KnowledgeScope = 'read' | 'write' | 'admin';

/**
 * Fail-closed ACL for knowledge access.
 * - scope must be 'read'
 * - requesterAgentId must equal targetAgentId (no cross-agent)
 * - empty values → 403
 */
export function assertKnowledgeAccess(args: {
  requesterAgentId: string;
  targetAgentId: string;
  scope: string;
}): void {
  const requester =
    typeof args.requesterAgentId === 'string' ? args.requesterAgentId.trim() : '';
  const target =
    typeof args.targetAgentId === 'string' ? args.targetAgentId.trim() : '';
  const scope = typeof args.scope === 'string' ? args.scope.trim() : '';

  if (!requester || !target) {
    throw errors.forbidden('Knowledge access: agentId 不可為空');
  }
  if (scope !== 'read') {
    throw errors.forbidden(
      `Knowledge access: scope 必須為 read（got ${scope || '(empty)'}）`,
    );
  }
  if (requester !== target) {
    throw errors.forbidden('Knowledge access: 禁止跨 Agent 讀取');
  }
}
