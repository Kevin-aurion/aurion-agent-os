const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyEntry {
  taskId: string;
  expiresAt: number;
}

export class IdempotencyStore {
  private readonly map = new Map<string, IdempotencyEntry>();

  static isValidKey(key: string): boolean {
    return KEY_RE.test(key);
  }

  get(key: string): IdempotencyEntry | undefined {
    this.gc();
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }

  set(key: string, taskId: string): void {
    this.map.set(key, { taskId, expiresAt: Date.now() + TTL_MS });
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt <= now) this.map.delete(k);
    }
  }
}
