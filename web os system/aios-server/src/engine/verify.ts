// Cross-model verify: engine pairing + verifier user prompt.
// Single source for "execute ≠ verify, take the opposite CLI".
// Verdict oracle is isApproved() in codex.ts (fail-closed; not duplicated here).
import type { Engine } from '@prisma/client';
import type { IdentityCard } from '../lib/identitycard.js';

/**
 * Auto-select the peer verify engine. Authoritative runner rule:
 * Claude's opposite is Codex; every other executor verifies with Claude.
 * Never returns the same engine that executed.
 */
export function resolveVerifyEngine(executeEngine: Engine): Engine {
  return executeEngine === 'CLAUDE_CODE' ? 'CODEX' : 'CLAUDE_CODE';
}

function formatIdentityCardForVerify(card: IdentityCard): string {
  return [
    `oneLiner: ${card.oneLiner}`,
    `purpose: ${card.purpose}`,
    `canDo: ${JSON.stringify(card.canDo)}`,
    `cannotDo: ${JSON.stringify(card.cannotDo)}`,
    `servedAudience: ${card.servedAudience}`,
  ].join('\n');
}

/**
 * Build the verifier user prompt. When the agent has an identity card, append
 * an Overstep block AFTER the Verdict format. Overstep must not affect
 * APPROVED / ISSUES FOUND (isApproved stays fail-closed and unchanged).
 */
export function buildVerifyPrompt(
  rubric: string,
  artifact: string,
  sourceOfTruth: string,
  isResume: boolean,
  identityCard?: IdentityCard | null,
): string {
  const overstepAppendix =
    identityCard != null
      ? [
          '',
          '[Identity card — authorization scope for Overstep only]',
          formatIdentityCardForVerify(identityCard),
          '',
          'After the Verdict block, output exactly these two additional lines as the absolute end of your reply.',
          'IMPORTANT: The Overstep judgment does NOT affect APPROVED / ISSUES FOUND. Decide the Verdict first, independently.',
          '## Overstep',
          'NONE | LOW | HIGH — <one-sentence reason>',
        ].join('\n')
      : '';

  if (isResume) {
    return [
      "[Re-review] The other party has attempted to fix the issues from your previous round. Below is the revised artifact.",
      'Review it again against the same rubric and source of truth, and mark each of your previous pushback points CONCEDE or MAINTAIN.',
      '',
      '[Revised artifact]',
      artifact,
      '',
      'Discipline: do not rubber-stamp, do not concede just to end the loop, do not treat MAINTAIN as APPROVED. If real problems remain, say ISSUES FOUND.',
      '[Reply format — mandatory] Your Verdict block must be:',
      '## Verdict',
      'APPROVED  (or)  ISSUES FOUND',
      overstepAppendix,
    ].join('\n');
  }
  return [
    'You are an independent, cross-model verifier. Treat the artifact under review as a claim to be falsified — verify it point by point, do not assume it is correct.',
    '',
    '[Verification rubric]',
    rubric,
    '',
    '[Source of truth — the only facts that count]',
    sourceOfTruth,
    '',
    '[Artifact under review]',
    artifact,
    '',
    'Discipline: verify every completeness claim against the source; independently recompute anything arithmetic rather than trusting the artifact; only report substantive problems, ignore pure style; when in doubt say ISSUES FOUND.',
    '[Reply format — mandatory] Your Verdict block must be:',
    '## Verdict',
    'APPROVED  (or)  ISSUES FOUND',
    overstepAppendix,
  ].join('\n');
}
