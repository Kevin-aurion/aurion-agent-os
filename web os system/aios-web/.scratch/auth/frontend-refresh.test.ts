/**
 * Front-end auth refresh single-flight test (no browser/network required).
 * Run: npx tsx .scratch/auth/frontend-refresh.test.ts
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function jwt(expSeconds: number, marker: string): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, marker }))
    .toString('base64url');
  return `header.${payload}.signature`;
}

async function main() {
  const storage = new MemoryStorage();
  const eventTarget = new EventTarget();
  Object.assign(globalThis, {
    localStorage: storage,
    window: eventTarget,
  });

  const { refreshAccess, tokens } = await import('../../src/lib/api.js');
  const oldAccess = jwt(Math.floor(Date.now() / 1000) - 10, 'old');
  const freshAccess = jwt(Math.floor(Date.now() / 1000) + 900, 'fresh');
  tokens.set(oldAccess, 'refresh-one');

  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({
      success: true,
      data: { access: freshAccess, refresh: 'refresh-two' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const results = await Promise.all([
    refreshAccess(oldAccess),
    refreshAccess(oldAccess),
    refreshAccess(oldAccess),
  ]);
  assert(results.every(Boolean), 'all waiting requests reuse the successful refresh');
  assert(fetchCount === 1, 'same-tab concurrent 401s make exactly one refresh request');
  assert(tokens.access === freshAccess, 'fresh access token is stored');
  assert(tokens.refresh === 'refresh-two', 'rotated refresh token is stored');

  const delayedOldRequest = await refreshAccess(oldAccess);
  assert(delayedOldRequest, 'a delayed old 401 reuses the already-fresh token');
  assert(fetchCount === 1, 'delayed old 401 does not rotate again');

  tokens.set(jwt(Math.floor(Date.now() / 1000) - 10, 'offline'), 'refresh-offline');
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  const offline = await refreshAccess(tokens.access);
  assert(!offline, 'network failure reports refresh failure');
  assert(tokens.refresh === 'refresh-offline', 'network outage does not erase a valid session');

  console.log('✓ concurrent 401 refresh is single-flight');
  console.log('✓ delayed old 401 reuses the fresh token');
  console.log('✓ temporary network failure preserves the session');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
