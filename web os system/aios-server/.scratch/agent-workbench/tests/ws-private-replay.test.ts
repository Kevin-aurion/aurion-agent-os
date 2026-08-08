/**
 * Workbench audit — WebSocket private-event isolation.
 * Run: npx tsx .scratch/agent-workbench/tests/ws-private-replay.test.ts
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { signAccess } from '../../../src/lib/auth.js';
import { Hub, type AwpFrame } from '../../../src/ws/hub.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function collect(ws: WebSocket): AwpFrame[] {
  const frames: AwpFrame[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString()) as AwpFrame));
  return frames;
}

async function settle(ms = 80) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(url: string, token: string): Promise<{ ws: WebSocket; frames: AwpFrame[] }> {
  const ws = new WebSocket(`${url}/ws?token=${encodeURIComponent(token)}`);
  const frames = collect(ws);
  await once(ws, 'open');
  await settle();
  return { ws, frames };
}

function subscribe(ws: WebSocket, lastSeq?: number) {
  ws.send(JSON.stringify({
    v: 1,
    id: `sub-${Math.random()}`,
    kind: 'req',
    topic: 'sub',
    ts: new Date().toISOString(),
    payload: { topics: ['chat.*'], ...(lastSeq === undefined ? {} : { lastSeq }) },
  }));
}

function eventPayloads(frames: AwpFrame[]): string[] {
  return frames
    .filter((frame) => frame.kind === 'event' && frame.topic === 'chat.message')
    .map((frame) => String((frame.payload as { marker?: string })?.marker));
}

async function main() {
  const hub = new Hub();
  const server = createServer();
  hub.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string', 'server must have a TCP address');
  const url = `ws://127.0.0.1:${address.port}`;

  const tokenA = await signAccess({ sub: 'ws-user-a', email: 'a@test.local', role: 'MEMBER' });
  const tokenB = await signAccess({ sub: 'ws-user-b', email: 'b@test.local', role: 'MEMBER' });
  const sockets: WebSocket[] = [];

  try {
    const a = await connect(url, tokenA);
    const b = await connect(url, tokenB);
    sockets.push(a.ws, b.ws);
    subscribe(a.ws);
    subscribe(b.ws);
    await settle();

    hub.publishToUser('ws-user-a', 'chat.message', { marker: 'a-live-secret' });
    await settle();
    assert(eventPayloads(a.frames).includes('a-live-secret'), 'A receives its targeted live event');
    assert(!eventPayloads(b.frames).includes('a-live-secret'), 'B must not receive A targeted live event');

    hub.publish('chat.message', { marker: 'public-live' });
    await settle();
    assert(eventPayloads(a.frames).includes('public-live'), 'A receives public live event');
    assert(eventPayloads(b.frames).includes('public-live'), 'B receives public live event');

    a.ws.close();
    b.ws.close();
    await Promise.all([once(a.ws, 'close'), once(b.ws, 'close')]);

    hub.publishToUser('ws-user-a', 'chat.message', { marker: 'a-replay-secret' });
    hub.publish('chat.message', { marker: 'public-replay' });

    const replayA = await connect(url, tokenA);
    const replayB = await connect(url, tokenB);
    sockets.push(replayA.ws, replayB.ws);
    subscribe(replayA.ws, 0);
    subscribe(replayB.ws, 0);
    await settle();

    assert(eventPayloads(replayA.frames).includes('a-replay-secret'), 'A replays its targeted event');
    assert(!eventPayloads(replayB.frames).includes('a-replay-secret'), 'B must not replay A targeted event');
    assert(eventPayloads(replayA.frames).includes('public-replay'), 'A replays public event');
    assert(eventPayloads(replayB.frames).includes('public-replay'), 'B replays public event');

    console.log('PASS: live delivery and replay isolate targeted events; public events remain compatible');
  } finally {
    for (const ws of sockets) ws.close();
    await settle();
    hub.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
