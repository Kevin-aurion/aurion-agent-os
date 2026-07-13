// AWP/1 — Aurion Wire Protocol v1. One WebSocket endpoint serves web + macOS
// identically. JSON envelope, topic pub/sub with wildcard suffix, 25s
// heartbeat, and at-least-once resume via a global monotonic seq + ring buffer.
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { verifyAccess } from '../lib/auth.js';

export type Kind = 'req' | 'res' | 'event' | 'ping' | 'pong' | 'err';

export interface AwpFrame {
  v: 1;
  id: string;
  kind: Kind;
  topic?: string;
  reqId?: string;
  seq?: number;
  ts: string;
  payload?: unknown;
}

interface Conn {
  id: string;
  userId: string;
  ws: WebSocket;
  subs: string[]; // topic patterns
  lastPong: number;
}

type ReqHandler = (payload: any, conn: { id: string; userId: string }) => Promise<unknown> | unknown;

function matches(pattern: string, topic: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return topic.startsWith(pattern.slice(0, -1));
  return pattern === topic;
}

const RING_CAP = 1000;

class Hub {
  private conns = new Map<string, Conn>();
  private seq = 0;
  private ring: AwpFrame[] = [];
  private reqHandlers = new Map<string, ReqHandler>();
  private heartbeat?: NodeJS.Timeout;

  /** Register a handler for client→server req frames on a topic. */
  onReq(topic: string, handler: ReqHandler) {
    this.reqHandlers.set(topic, handler);
  }

  private frame(kind: Kind, extra: Partial<AwpFrame>): AwpFrame {
    return { v: 1, id: ulid(), kind, ts: new Date().toISOString(), ...extra };
  }

  private send(ws: WebSocket, f: AwpFrame) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  }

  /** Publish a server event to all subscribers; buffered for resume. */
  publish(topic: string, payload: unknown) {
    const f = this.frame('event', { topic, seq: ++this.seq, payload });
    this.ring.push(f);
    if (this.ring.length > RING_CAP) this.ring.shift();
    for (const c of this.conns.values()) {
      if (c.subs.some((p) => matches(p, topic))) this.send(c.ws, f);
    }
  }

  private replay(conn: Conn, lastSeq: number) {
    const missed = this.ring.filter((f) => (f.seq ?? 0) > lastSeq && conn.subs.some((p) => matches(p, f.topic!)));
    if (lastSeq > 0 && missed.length === 0 && this.ring.length && (this.ring[0]!.seq ?? 0) > lastSeq + 1) {
      // requested seq already fell out of the buffer
      this.send(conn.ws, this.frame('err', { payload: { code: 'RESUME_GAP', message: 'refetch state via REST' } }));
      return;
    }
    for (const f of missed) this.send(conn.ws, f);
  }

  private async register(ws: WebSocket, userId: string) {
    const conn: Conn = { id: ulid(), userId, ws, subs: [], lastPong: Date.now() };
    this.conns.set(conn.id, conn);
    this.send(ws, this.frame('event', { topic: 'hello', seq: this.seq, payload: { connId: conn.id, userId } }));

    ws.on('message', async (buf) => {
      let f: AwpFrame;
      try {
        f = JSON.parse(buf.toString());
      } catch {
        return this.send(ws, this.frame('err', { payload: { code: 'BAD_FRAME' } }));
      }
      if (f.kind === 'pong') {
        conn.lastPong = Date.now();
        return;
      }
      if (f.kind === 'ping') return this.send(ws, this.frame('pong', { reqId: f.id }));
      if (f.kind === 'req') return this.handleReq(conn, f);
    });

    ws.on('close', () => this.conns.delete(conn.id));
    ws.on('error', () => this.conns.delete(conn.id));
  }

  private async handleReq(conn: Conn, f: AwpFrame) {
    const topic = f.topic ?? '';
    const payload: any = f.payload ?? {};
    try {
      if (topic === 'sub') {
        const topics: string[] = Array.isArray(payload.topics) ? payload.topics : [];
        conn.subs = Array.from(new Set([...conn.subs, ...topics]));
        this.send(conn.ws, this.frame('res', { reqId: f.id, payload: { subscribed: conn.subs } }));
        if (typeof payload.lastSeq === 'number') this.replay(conn, payload.lastSeq);
        return;
      }
      if (topic === 'unsub') {
        const topics: string[] = Array.isArray(payload.topics) ? payload.topics : [];
        conn.subs = conn.subs.filter((s) => !topics.includes(s));
        return this.send(conn.ws, this.frame('res', { reqId: f.id, payload: { subscribed: conn.subs } }));
      }
      const handler = this.reqHandlers.get(topic);
      if (!handler) {
        return this.send(conn.ws, this.frame('err', { reqId: f.id, payload: { code: 'NO_HANDLER', topic } }));
      }
      const data = await handler(payload, { id: conn.id, userId: conn.userId });
      this.send(conn.ws, this.frame('res', { reqId: f.id, topic, payload: data }));
    } catch (e) {
      this.send(conn.ws, this.frame('err', { reqId: f.id, topic, payload: { message: e instanceof Error ? e.message : String(e) } }));
    }
  }

  attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', async (rawReq, socket, head) => {
      const url = new URL(rawReq.url ?? '', 'http://localhost');
      if (url.pathname !== '/ws') return;
      const token = url.searchParams.get('token') ?? '';
      let userId: string;
      try {
        userId = (await verifyAccess(token)).sub;
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(rawReq, socket, head, (ws) => this.register(ws, userId));
    });

    this.heartbeat = setInterval(() => {
      const now = Date.now();
      for (const c of this.conns.values()) {
        if (now - c.lastPong > 60_000) {
          c.ws.terminate();
          this.conns.delete(c.id);
          continue;
        }
        this.send(c.ws, this.frame('ping', {}));
      }
    }, 25_000);
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.conns.values()) c.ws.close();
  }

  get connectionCount() {
    return this.conns.size;
  }
}

export const hub = new Hub();
