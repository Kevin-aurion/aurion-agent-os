// Per-deployment rate limit + circuit breaker (Phase 6 / Ticket 21).
// Pure in-memory logic; injectable now() for tests. Env read at check-time.
// Fail-closed: reject when over limit or circuit OPEN.

export type RateLimitDecision = { allow: true } | { allow: false; reason: string };
export type CircuitDecision =
  | { allow: true; state: 'CLOSED' | 'HALF_OPEN' }
  | { allow: false; state: 'OPEN'; reason: string };

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

type DeploymentGuard = {
  /** Timestamps (ms) of allowed dispatches in the sliding window. */
  windowHits: number[];
  circuit: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenProbeInFlight: boolean;
};

const state = new Map<string, DeploymentGuard>();

function getOrCreate(deploymentId: string): DeploymentGuard {
  let g = state.get(deploymentId);
  if (!g) {
    g = {
      windowHits: [],
      circuit: 'CLOSED',
      consecutiveFailures: 0,
      openedAt: null,
      halfOpenProbeInFlight: false,
    };
    state.set(deploymentId, g);
  }
  return g;
}

function rateLimitPerMin(): number {
  const raw = process.env.AIOS_RUNTIME_RATE_LIMIT_PER_MIN;
  if (raw == null || raw.trim() === '') return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

function circuitThreshold(): number {
  const raw = process.env.AIOS_RUNTIME_CIRCUIT_THRESHOLD;
  if (raw == null || raw.trim() === '') return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

function circuitCooldownMs(): number {
  const raw = process.env.AIOS_RUNTIME_CIRCUIT_COOLDOWN_MS;
  if (raw == null || raw.trim() === '') return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60_000;
}

const WINDOW_MS = 60_000;

/**
 * Sliding-window rate limit per deploymentId (default 30/min).
 * Records a hit only when allow=true.
 */
export function checkRateLimit(
  deploymentId: string,
  now: number = Date.now(),
): RateLimitDecision {
  if (!deploymentId) {
    return { allow: false, reason: 'deploymentId required' };
  }
  const g = getOrCreate(deploymentId);
  const limit = rateLimitPerMin();
  const cutoff = now - WINDOW_MS;
  g.windowHits = g.windowHits.filter((t) => t > cutoff);
  if (g.windowHits.length >= limit) {
    return {
      allow: false,
      reason: `rate limit exceeded (${limit}/min) for deployment ${deploymentId}`,
    };
  }
  g.windowHits.push(now);
  return { allow: true };
}

/**
 * Circuit gate before adapter dispatch. OPEN → reject until cooldown, then
 * HALF_OPEN allows a single probe.
 */
export function beforeDispatch(
  deploymentId: string,
  now: number = Date.now(),
): CircuitDecision {
  if (!deploymentId) {
    return { allow: false, state: 'OPEN', reason: 'deploymentId required' };
  }
  const g = getOrCreate(deploymentId);
  const cooldown = circuitCooldownMs();

  if (g.circuit === 'OPEN') {
    if (g.openedAt != null && now - g.openedAt >= cooldown) {
      g.circuit = 'HALF_OPEN';
      g.halfOpenProbeInFlight = false;
    } else {
      return {
        allow: false,
        state: 'OPEN',
        reason: `circuit OPEN for deployment ${deploymentId}`,
      };
    }
  }

  if (g.circuit === 'HALF_OPEN') {
    if (g.halfOpenProbeInFlight) {
      return {
        allow: false,
        state: 'OPEN',
        reason: `circuit HALF_OPEN probe in flight for deployment ${deploymentId}`,
      };
    }
    g.halfOpenProbeInFlight = true;
    return { allow: true, state: 'HALF_OPEN' };
  }

  return { allow: true, state: 'CLOSED' };
}

export function recordSuccess(deploymentId: string): void {
  if (!deploymentId) return;
  const g = getOrCreate(deploymentId);
  g.circuit = 'CLOSED';
  g.consecutiveFailures = 0;
  g.openedAt = null;
  g.halfOpenProbeInFlight = false;
}

export function recordFailure(
  deploymentId: string,
  now: number = Date.now(),
): void {
  if (!deploymentId) return;
  const g = getOrCreate(deploymentId);
  g.consecutiveFailures += 1;
  g.halfOpenProbeInFlight = false;
  const threshold = circuitThreshold();
  if (g.circuit === 'HALF_OPEN' || g.consecutiveFailures >= threshold) {
    g.circuit = 'OPEN';
    g.openedAt = now;
  }
}

/** Test-only: wipe in-memory state. */
export function _resetRuntimeGuardStateForTests(): void {
  state.clear();
}

/** Test-only: inspect circuit state (optional helper). */
export function _getRuntimeGuardSnapshotForTests(deploymentId: string): {
  circuit: CircuitState;
  consecutiveFailures: number;
  windowHits: number;
} | null {
  const g = state.get(deploymentId);
  if (!g) return null;
  return {
    circuit: g.circuit,
    consecutiveFailures: g.consecutiveFailures,
    windowHits: g.windowHits.length,
  };
}
