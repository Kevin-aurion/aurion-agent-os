// Agent identity card: one-liner role, can/cannot, audience, example commands.
// Pure helpers — no DB / Fastify deps so they stay unit-testable.

export interface IdentityCard {
  oneLiner: string;
  purpose: string;
  canDo: string[];
  cannotDo: string[];
  servedAudience: string;
  exampleCommands: string[];
}

const EMPTY_CARD: IdentityCard = {
  oneLiner: '',
  purpose: '',
  canDo: [],
  cannotDo: [],
  servedAudience: '',
  exampleCommands: [],
};

const MAX_EXAMPLE_COMMANDS = 5;

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asStringArray(v: unknown): { items: string[]; discarded: number } {
  if (!Array.isArray(v)) return { items: [], discarded: 0 };
  const items: string[] = [];
  let discarded = 0;
  for (const el of v) {
    if (typeof el === 'string') items.push(el);
    else discarded += 1;
  }
  return { items, discarded };
}

/**
 * Validate + normalize raw input into an IdentityCard.
 * Missing fields get empty defaults; non-strings are discarded;
 * exampleCommands is capped at 5. Returns { card, errors }.
 */
export function parseIdentityCard(raw: unknown): { card: IdentityCard; errors: string[] } {
  const errors: string[] = [];

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw != null) errors.push('identityCard must be an object');
    return { card: { ...EMPTY_CARD }, errors };
  }

  const o = raw as Record<string, unknown>;
  const card: IdentityCard = { ...EMPTY_CARD };

  const oneLiner = asString(o.oneLiner);
  if (oneLiner != null) card.oneLiner = oneLiner;
  else if (o.oneLiner !== undefined) errors.push('oneLiner must be a string');

  const purpose = asString(o.purpose);
  if (purpose != null) card.purpose = purpose;
  else if (o.purpose !== undefined) errors.push('purpose must be a string');

  const servedAudience = asString(o.servedAudience);
  if (servedAudience != null) card.servedAudience = servedAudience;
  else if (o.servedAudience !== undefined) errors.push('servedAudience must be a string');

  if (o.canDo !== undefined) {
    if (!Array.isArray(o.canDo)) {
      errors.push('canDo must be an array of strings');
    } else {
      const { items, discarded } = asStringArray(o.canDo);
      card.canDo = items;
      if (discarded > 0) errors.push(`canDo: discarded ${discarded} non-string item(s)`);
    }
  }

  if (o.cannotDo !== undefined) {
    if (!Array.isArray(o.cannotDo)) {
      errors.push('cannotDo must be an array of strings');
    } else {
      const { items, discarded } = asStringArray(o.cannotDo);
      card.cannotDo = items;
      if (discarded > 0) errors.push(`cannotDo: discarded ${discarded} non-string item(s)`);
    }
  }

  if (o.exampleCommands !== undefined) {
    if (!Array.isArray(o.exampleCommands)) {
      errors.push('exampleCommands must be an array of strings');
    } else {
      const { items, discarded } = asStringArray(o.exampleCommands);
      if (discarded > 0) errors.push(`exampleCommands: discarded ${discarded} non-string item(s)`);
      if (items.length > MAX_EXAMPLE_COMMANDS) {
        errors.push(`exampleCommands truncated to ${MAX_EXAMPLE_COMMANDS}`);
        card.exampleCommands = items.slice(0, MAX_EXAMPLE_COMMANDS);
      } else {
        card.exampleCommands = items;
      }
    }
  }

  return { card, errors };
}

/**
 * Factory completeness check: oneLiner/purpose non-empty,
 * canDo ≥ 1, exampleCommands ≥ 1 → complete.
 */
export function checkIdentityCard(card: IdentityCard): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!card.oneLiner.trim()) missing.push('oneLiner');
  if (!card.purpose.trim()) missing.push('purpose');
  if (card.canDo.length < 1) missing.push('canDo');
  if (card.exampleCommands.length < 1) missing.push('exampleCommands');
  return { complete: missing.length === 0, missing };
}

/** Empty card shape used when Agent.identityCard is null. */
export function emptyIdentityCard(): IdentityCard {
  return { ...EMPTY_CARD };
}
