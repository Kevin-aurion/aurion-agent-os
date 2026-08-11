// Skill IR schema (aios.skill-ir/1) — fail-closed strict parse.
import { z } from 'zod';
import { redactSecrets } from '../memory/redactor.js';

export const SKILL_IR_SCHEMA_VERSION = 'aios.skill-ir/1' as const;

export const SkillIrSchema = z
  .object({
    schemaVersion: z.literal(SKILL_IR_SCHEMA_VERSION),
    template: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    slots: z.record(z.unknown()),
  })
  .strict();

export type SkillIr = z.infer<typeof SkillIrSchema>;

/**
 * Fail-closed parse of Skill IR. Throws Error with redacted message on invalid input.
 */
export function parseSkillIr(input: unknown): SkillIr {
  const result = SkillIrSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(redactSecrets(`invalid Skill IR: ${detail}`));
  }
  return result.data;
}
