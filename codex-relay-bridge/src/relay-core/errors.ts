export type BridgeErrorCode =
  | "invalid_input"
  | "conflict"
  | "codex_error"
  | "not_supported"
  | "timeout"
  | "disconnected"
  | "protocol_violation"
  | "degraded"
  | "internal";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details?: unknown;

  constructor(code: BridgeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function isBridgeError(err: unknown): err is BridgeError {
  return err instanceof BridgeError;
}
