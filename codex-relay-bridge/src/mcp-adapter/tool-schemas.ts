/**
 * JSON Schema for the five MCP tools.
 * All schemas use additionalProperties: false.
 * Validation failures return invalid_input without calling App Server.
 */

export const IDEMPOTENCY_KEY_PATTERN = "^[A-Za-z0-9._-]{1,128}$";

export const toolDefinitions = [
  {
    name: "codex_start_task",
    description:
      "Start a new Codex thread in a project directory and send the first user message.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project", "message", "idempotency_key"],
      properties: {
        project: {
          type: "string",
          description: "Absolute path to the project working directory",
        },
        message: {
          type: "string",
          minLength: 1,
          description: "Initial user message",
        },
        idempotency_key: {
          type: "string",
          pattern: IDEMPOTENCY_KEY_PATTERN,
          description: "Idempotency key (1-128 chars: A-Za-z0-9._-)",
        },
      },
    },
  },
  {
    name: "codex_continue_task",
    description:
      "Continue an existing Codex thread (turn/start if idle, turn/steer if active).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["thread_id", "message"],
      properties: {
        thread_id: { type: "string" },
        message: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "codex_get_status",
    description: "Read task status, pending approvals, and diagnostics (pure read).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      anyOf: [
        { required: ["task_id"] },
        { required: ["thread_id"] },
      ],
      properties: {
        task_id: { type: "string" },
        thread_id: { type: "string" },
      },
    },
  },
  {
    name: "codex_read_output",
    description: "Read normalized events for a task from a cursor (pure read).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: {
        task_id: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "codex_respond_approval",
    description:
      "Respond to a pending approval request (allow|deny). Fail-closed for high-risk kinds.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["request_id", "decision"],
      properties: {
        request_id: { type: "string" },
        decision: { type: "string", enum: ["allow", "deny"] },
        note: { type: "string" },
      },
    },
  },
] as const;

export type ToolName = (typeof toolDefinitions)[number]["name"];

export interface ValidationResult {
  ok: boolean;
  error?: string;
  value?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Minimal JSON Schema subset validator for our tool inputs.
 * Enforces additionalProperties: false, required, types, minLength, pattern, enum, anyOf.
 */
export function validateToolInput(
  toolName: string,
  args: unknown,
): ValidationResult {
  const def = toolDefinitions.find((t) => t.name === toolName);
  if (!def) {
    return { ok: false, error: `unknown tool: ${toolName}` };
  }
  const schema = def.inputSchema as {
    type: string;
    additionalProperties: boolean;
    required?: readonly string[];
    properties: Record<string, Record<string, unknown>>;
    anyOf?: ReadonlyArray<{ required: readonly string[] }>;
  };

  if (!isPlainObject(args)) {
    return { ok: false, error: "arguments must be an object" };
  }

  // additionalProperties: false
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) {
      return { ok: false, error: `unexpected property: ${key}` };
    }
  }

  // anyOf required sets
  if (schema.anyOf) {
    const matched = schema.anyOf.some((clause) =>
      clause.required.every(
        (k) => args[k] !== undefined && args[k] !== null && args[k] !== "",
      ),
    );
    if (!matched) {
      return {
        ok: false,
        error: `must satisfy one of: ${schema.anyOf
          .map((c) => c.required.join("+"))
          .join(" | ")}`,
      };
    }
  }

  // required
  if (schema.required) {
    for (const k of schema.required) {
      if (args[k] === undefined || args[k] === null) {
        return { ok: false, error: `missing required property: ${k}` };
      }
    }
  }

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in args)) continue;
    const val = args[key];
    const t = propSchema.type as string | undefined;

    if (t === "string") {
      if (typeof val !== "string") {
        return { ok: false, error: `${key} must be a string` };
      }
      if (
        typeof propSchema.minLength === "number" &&
        val.length < propSchema.minLength
      ) {
        return {
          ok: false,
          error: `${key} must have minLength ${propSchema.minLength}`,
        };
      }
      if (typeof propSchema.pattern === "string") {
        const re = new RegExp(propSchema.pattern);
        if (!re.test(val)) {
          return { ok: false, error: `${key} does not match pattern` };
        }
      }
      if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(val)) {
        return {
          ok: false,
          error: `${key} must be one of: ${(propSchema.enum as string[]).join("|")}`,
        };
      }
    } else if (t === "integer") {
      if (typeof val !== "number" || !Number.isInteger(val)) {
        return { ok: false, error: `${key} must be an integer` };
      }
      if (
        typeof propSchema.minimum === "number" &&
        val < propSchema.minimum
      ) {
        return {
          ok: false,
          error: `${key} must be >= ${propSchema.minimum}`,
        };
      }
    }
  }

  return { ok: true, value: args };
}
