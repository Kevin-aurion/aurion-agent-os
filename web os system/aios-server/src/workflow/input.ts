// Canonical workflow-input contract shared by REST/MCP invocation and the
// workflow runner. This keeps callers from having to guess whether a natural
// language request should be named message, question or query.

export interface WorkflowInputIssue {
  path: string;
  code: 'required' | 'type' | 'additional_property' | 'invalid_schema';
  message: string;
}

export interface WorkflowInputPreparation {
  input: Record<string, unknown>;
  issues: WorkflowInputIssue[];
  normalizedFrom: string | null;
  schema: Record<string, unknown> | null;
}

export interface WorkflowForAutomaticSelection {
  id: string;
  name: string;
  trigger: unknown;
  inputSchema: unknown;
  steps?: Array<{ config: unknown }>;
}

const NATURAL_LANGUAGE_ALIASES = ['question', 'query', 'prompt', 'text', 'request'] as const;

export const NATURAL_LANGUAGE_WORKFLOW_INPUT_SCHEMA = {
  type: 'object',
  required: ['message'],
  properties: {
    message: {
      type: 'string',
      minLength: 1,
      description: '使用者交代給 AI 員工的原始自然語言工作內容。',
    },
  },
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsMessageTemplate(value: unknown): boolean {
  if (typeof value === 'string') return /\{\{\s*input\.message\s*\}\}/.test(value);
  if (Array.isArray(value)) return value.some(containsMessageTemplate);
  if (!isObject(value)) return false;
  return Object.values(value).some(containsMessageTemplate);
}

/**
 * Prefer an authored JSON Schema. For legacy workflows, infer the one stable
 * natural-language contract only when a step explicitly uses
 * `{{input.message}}`; other fields are never guessed.
 */
export function effectiveWorkflowInputSchema(
  schema: unknown,
  steps: Array<{ config: unknown }> = [],
): Record<string, unknown> | null {
  if (isObject(schema)) return schema;
  if (steps.some((step) => containsMessageTemplate(step.config))) {
    return NATURAL_LANGUAGE_WORKFLOW_INPUT_SCHEMA as unknown as Record<string, unknown>;
  }
  return null;
}

export function extractNaturalLanguageMessage(input: Record<string, unknown>): string | null {
  if (typeof input.message === 'string' && input.message.trim()) return input.message.trim();
  for (const key of NATURAL_LANGUAGE_ALIASES) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function schemaAcceptsMessage(schema: Record<string, unknown> | null): boolean {
  if (!schema) return false;
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.hasOwn(properties, 'message') || required.includes('message');
}

function valueMatchesType(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((item) => valueMatchesType(value, item));
  switch (expected) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    case 'null': return value === null;
    default: return true;
  }
}

function validateAgainstSchema(
  schema: Record<string, unknown> | null,
  input: Record<string, unknown>,
): WorkflowInputIssue[] {
  if (!schema) return [];
  if (schema.type != null && schema.type !== 'object') {
    return [{ path: 'input', code: 'invalid_schema', message: 'Workflow inputSchema 的根節點必須是 object。' }];
  }

  const issues: WorkflowInputIssue[] = [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  const properties = isObject(schema.properties) ? schema.properties : {};

  for (const key of required) {
    if (!Object.hasOwn(input, key) || input[key] == null) {
      issues.push({ path: `input.${key}`, code: 'required', message: `缺少必要欄位 ${key}` });
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const propertySchema = properties[key];
    if (propertySchema == null) {
      if (schema.additionalProperties === false) {
        issues.push({ path: `input.${key}`, code: 'additional_property', message: `不接受欄位 ${key}` });
      }
      continue;
    }
    if (!isObject(propertySchema)) continue;
    if (!valueMatchesType(value, propertySchema.type)) {
      issues.push({
        path: `input.${key}`,
        code: 'type',
        message: `${key} 的格式必須是 ${String(propertySchema.type)}`,
      });
      continue;
    }
    if (
      typeof value === 'string' &&
      typeof propertySchema.minLength === 'number' &&
      value.length < propertySchema.minLength
    ) {
      issues.push({ path: `input.${key}`, code: 'type', message: `${key} 不可為空白` });
    }
    if (Array.isArray(propertySchema.enum) && !propertySchema.enum.includes(value)) {
      issues.push({ path: `input.${key}`, code: 'type', message: `${key} 不是允許的值` });
    }
  }

  return issues;
}

/** Normalize familiar natural-language aliases, then validate before a Run is queued. */
export function prepareWorkflowInput(
  input: Record<string, unknown>,
  schema: unknown,
  steps: Array<{ config: unknown }> = [],
): WorkflowInputPreparation {
  const effectiveSchema = effectiveWorkflowInputSchema(schema, steps);
  const normalized = { ...input };
  let normalizedFrom: string | null = null;

  if (schemaAcceptsMessage(effectiveSchema) && !(typeof normalized.message === 'string' && normalized.message.trim())) {
    for (const alias of NATURAL_LANGUAGE_ALIASES) {
      const value = normalized[alias];
      if (typeof value !== 'string' || !value.trim()) continue;
      normalized.message = value.trim();
      normalizedFrom = alias;
      const properties = isObject(effectiveSchema?.properties) ? effectiveSchema.properties : {};
      if (!Object.hasOwn(properties, alias)) delete normalized[alias];
      break;
    }
  }

  return {
    input: normalized,
    issues: validateAgainstSchema(effectiveSchema, normalized),
    normalizedFrom,
    schema: effectiveSchema,
  };
}

function keywordMatch(trigger: unknown, message: string): boolean {
  if (!isObject(trigger) || trigger.type !== 'keyword' || !Array.isArray(trigger.keywords)) return false;
  const haystack = message.toLowerCase();
  return trigger.keywords.some(
    (keyword) => typeof keyword === 'string' && keyword.trim() !== '' && haystack.includes(keyword.toLowerCase()),
  );
}

/**
 * Automatic routing is deterministic: one keyword match wins; otherwise the
 * sole workflow may be selected only when it declares the canonical message
 * input. Ambiguous matches are returned to the caller instead of guessed.
 */
export function selectAutomaticWorkflow<T extends WorkflowForAutomaticSelection>(
  workflows: T[],
  input: Record<string, unknown>,
): { workflow: T | null; ambiguous: T[]; reason: 'keyword' | 'sole_message_workflow' | 'none' | 'ambiguous' } {
  const message = extractNaturalLanguageMessage(input);
  if (!message) return { workflow: null, ambiguous: [], reason: 'none' };

  const keywordMatches = workflows.filter((workflow) => keywordMatch(workflow.trigger, message));
  if (keywordMatches.length === 1) {
    return { workflow: keywordMatches[0]!, ambiguous: [], reason: 'keyword' };
  }
  if (keywordMatches.length > 1) {
    return { workflow: null, ambiguous: keywordMatches, reason: 'ambiguous' };
  }

  if (workflows.length === 1) {
    const only = workflows[0]!;
    const schema = effectiveWorkflowInputSchema(only.inputSchema, only.steps ?? []);
    if (schemaAcceptsMessage(schema)) {
      return { workflow: only, ambiguous: [], reason: 'sole_message_workflow' };
    }
  }

  return { workflow: null, ambiguous: [], reason: 'none' };
}
