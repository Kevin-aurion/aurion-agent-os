// AuthManager: login / refresh / proactive-rotation timer / on-401 forced re-auth.
//
// Strategy (mirrors aios-server's human auth flow — there is no service/API-key mechanism):
// 1. Try the persisted single-use refresh token (session.json) via POST /api/auth/refresh.
// 2. Fall back to POST /api/auth/login with AIOS_MCP_EMAIL/PASSWORD.
// 3. A 10-minute interval proactively rotates the 15-minute access JWT; the rotated
//    refresh token is re-persisted immediately (refresh tokens are single-use).
// Access tokens live in memory only; only the refresh token touches disk (mode 0600).
import type { Config } from '../config.js';
import { clearState, loadState, saveState } from './state.js';

const ROTATE_INTERVAL_MS = 10 * 60 * 1000; // access TTL is 15m; rotate every 10m

interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

interface TokenBundle {
  access: string;
  refresh: string;
  user: AuthUser;
}

type Envelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; detail?: unknown } };

export class AuthManager {
  private access: string | null = null;
  private refresh: string | null = null;
  private user: AuthUser | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly config: Config) {}

  /** Establish a session (refresh-or-login) and start the proactive rotation timer. */
  async start(): Promise<void> {
    try {
      await this.ensureSession();
    } catch (err) {
      // Do not kill the process: unauthenticated tools (get_health/get_preflight) still
      // work, and authenticated calls retry the login lazily via getAccess().
      console.error(
        `aios-mcp: initial authentication failed (${err instanceof Error ? err.message : String(err)}); ` +
          'will retry on first authenticated call.',
      );
    }
    this.timer = setInterval(() => {
      this.ensureSession(true).catch((err) => {
        console.error(
          `aios-mcp: proactive token rotation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, ROTATE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Current access JWT, establishing a session first if needed. */
  async getAccess(): Promise<string> {
    if (!this.access) await this.ensureSession();
    if (!this.access) throw new Error('aios-mcp: no access token available after authentication');
    return this.access;
  }

  /** Called by the HTTP client on a 401: force one refresh-or-login cycle. */
  async forceReauth(): Promise<void> {
    await this.ensureSession(true);
  }

  /** Explicit one-shot logout (AIOS_MCP_LOGOUT=1): revoke the persisted refresh token. */
  async logout(): Promise<void> {
    const persisted = await loadState(this.config.stateDir);
    const refresh = this.refresh ?? persisted?.refresh ?? null;
    if (refresh) {
      try {
        await this.post('/api/auth/logout', { refresh });
      } catch (err) {
        console.error(
          `aios-mcp: logout call failed (token may already be revoked): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await clearState(this.config.stateDir);
    this.access = null;
    this.refresh = null;
    this.user = null;
  }

  /** Refresh-or-login, deduplicating concurrent callers onto one in-flight cycle. */
  private ensureSession(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.access && !force) return Promise.resolve();
    this.inFlight = this.doEnsureSession().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doEnsureSession(): Promise<void> {
    const refresh = this.refresh ?? (await loadState(this.config.stateDir))?.refresh ?? null;
    if (refresh) {
      try {
        await this.applyBundle(
          await this.post<TokenBundle>('/api/auth/refresh', {
            refresh,
            client: this.config.clientName,
          }),
        );
        return;
      } catch (err) {
        console.error(
          `aios-mcp: refresh token rejected (${err instanceof Error ? err.message : String(err)}); logging in again.`,
        );
      }
    }
    await this.applyBundle(
      await this.post<TokenBundle>('/api/auth/login', {
        email: this.config.email,
        password: this.config.password,
        client: this.config.clientName,
      }),
    );
  }

  private async applyBundle(bundle: TokenBundle): Promise<void> {
    this.access = bundle.access;
    this.refresh = bundle.refresh;
    this.user = bundle.user;
    // Refresh tokens are single-use (rotated server-side) — persist the new one immediately.
    await saveState(this.config.stateDir, {
      refresh: bundle.refresh,
      userId: bundle.user.id,
      email: bundle.user.email,
    });
  }

  /** Minimal raw JSON POST against aios-server (auth endpoints only; no bearer header). */
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `cannot reach aios-server at ${this.config.baseUrl} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    let json: Envelope<T>;
    try {
      json = (await res.json()) as Envelope<T>;
    } catch {
      throw new Error(`${path} returned non-JSON response (HTTP ${res.status})`);
    }
    if (!json.success) {
      throw new Error(`${path} failed: [${json.error.code}] ${json.error.message}`);
    }
    return json.data;
  }
}
