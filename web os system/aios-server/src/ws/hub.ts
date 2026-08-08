// AWP/1 — Aurion Wire Protocol v1. User channel `/ws` (JWT + ring/replay) and
// dedicated device channel `/device/ws` (Authorization Bearer only; no user ring).
// JSON envelope, topic pub/sub with wildcard suffix, 25s heartbeat.
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import { ulid } from 'ulid';
import { verifyAccess } from '../lib/auth.js';
import {
  authenticateDeviceToken,
  touchDeviceLastSeen,
  updateDeviceCapabilities,
  DeviceCapabilitiesSchema,
  HEARTBEAT_FRESH_MS,
} from '../lib/device.js';

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
  role: string;
  ws: WebSocket;
  subs: string[];
  lastPong: number;
}

interface DeviceConn {
  id: string;
  deviceId: string;
  ws: WebSocket;
  lastPong: number;
}

interface BufferedEvent {
  frame: AwpFrame;
  userId?: string;
}

type ReqHandler = (payload: any, conn: { id: string; userId: string; role: string }) => Promise<unknown> | unknown;

function matches(pattern: string, topic: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return topic.startsWith(pattern.slice(0, -1));
  return pattern === topic;
}

const RING_CAP = 1000;

/** Fixed subprotocol identifier only — never carries the device secret. */
const DEVICE_SUBPROTOCOL = 'aios-device';

export class Hub {
  private conns = new Map<string, Conn>();
  private deviceConns = new Map<string, DeviceConn>();
  private seq = 0;
  private ring: BufferedEvent[] = [];
  private lastDroppedPublicSeq = 0;
  private lastDroppedUserSeq = new Map<string, number>();
  private reqHandlers = new Map<string, ReqHandler>();
  private heartbeat?: NodeJS.Timeout;

  onReq(topic: string, handler: ReqHandler) {
    this.reqHandlers.set(topic, handler);
  }

  private frame(kind: Kind, extra: Partial<AwpFrame>): AwpFrame {
    return { v: 1, id: ulid(), kind, ts: new Date().toISOString(), ...extra };
  }

  private send(ws: WebSocket, f: AwpFrame) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  }

  private buffer(event: BufferedEvent) {
    this.ring.push(event);
    if (this.ring.length <= RING_CAP) return;

    const dropped = this.ring.shift()!;
    const droppedSeq = dropped.frame.seq ?? 0;
    if (dropped.userId) this.lastDroppedUserSeq.set(dropped.userId, droppedSeq);
    else this.lastDroppedPublicSeq = droppedSeq;
  }

  private publishEvent(topic: string, payload: unknown, userId?: string) {
    const f = this.frame('event', { topic, seq: ++this.seq, payload });
    this.buffer({ frame: f, userId });
    for (const c of this.conns.values()) {
      if (userId && c.userId !== userId) continue;
      if (c.subs.some((p) => matches(p, topic))) this.send(c.ws, f);
    }
  }

  publish(topic: string, payload: unknown) {
    this.publishEvent(topic, payload);
  }

  publishToUser(userId: string, topic: string, payload: unknown) {
    this.publishEvent(topic, payload, userId);
  }

  /**
   * Targeted device event. Requires OPEN socket + fresh lastPong.
   * Does NOT enter the user ring buffer.
   */
  publishToDevice(deviceId: string, topic: string, payload: unknown): boolean {
    if (!this.isDeviceOnline(deviceId)) return false;
    const dc = this.deviceConns.get(deviceId);
    if (!dc) return false;
    const f = this.frame('event', { topic, seq: ++this.seq, payload });
    this.send(dc.ws, f);
    return true;
  }

  /**
   * Online = authenticated OPEN WebSocket AND lastPong within freshness window.
   */
  isDeviceOnline(deviceId: string): boolean {
    const dc = this.deviceConns.get(deviceId);
    if (!dc || dc.ws.readyState !== WebSocket.OPEN) return false;
    return Date.now() - dc.lastPong <= HEARTBEAT_FRESH_MS;
  }

  /**
   * Immediately drop the device socket (revoke/rotate/admin).
   * After this, publishToDevice returns false until re-auth with new token.
   */
  disconnectDevice(deviceId: string, code = 4001, reason = 'disconnected'): void {
    const dc = this.deviceConns.get(deviceId);
    if (!dc) return;
    this.deviceConns.delete(deviceId);
    try {
      dc.ws.close(code, reason.slice(0, 120));
    } catch {
      try {
        dc.ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  private replay(conn: Conn, lastSeq: number) {
    const lastDroppedVisibleSeq = Math.max(
      this.lastDroppedPublicSeq,
      this.lastDroppedUserSeq.get(conn.userId) ?? 0,
    );
    if (lastSeq > 0 && lastSeq < lastDroppedVisibleSeq) {
      this.send(conn.ws, this.frame('err', { payload: { code: 'RESUME_GAP', message: 'refetch state via REST' } }));
      return;
    }

    const missed = this.ring.filter(({ frame, userId }) =>
      (frame.seq ?? 0) > lastSeq
      && (!userId || userId === conn.userId)
      && conn.subs.some((p) => matches(p, frame.topic!)),
    );
    for (const { frame } of missed) this.send(conn.ws, frame);
  }

  private async register(ws: WebSocket, userId: string, role: string) {
    const conn: Conn = { id: ulid(), userId, role, ws, subs: [], lastPong: Date.now() };
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
      const data = await handler(payload, { id: conn.id, userId: conn.userId, role: conn.role });
      this.send(conn.ws, this.frame('res', { reqId: f.id, topic, payload: data }));
    } catch (e) {
      this.send(conn.ws, this.frame('err', { reqId: f.id, topic, payload: { message: e instanceof Error ? e.message : String(e) } }));
    }
  }

  /**
   * Device auth: Authorization Bearer only.
   * Query tokens rejected. Sec-WebSocket-Protocol may only be fixed "aios-device"
   * (no secret, never used as credential).
   */
  private extractDeviceBearer(rawReq: IncomingMessage, url: URL): string | null {
    if (url.searchParams.has('token') || url.searchParams.has('deviceToken')) {
      return null;
    }

    // Reject any subprotocol that embeds a secret (aios-device.<token> etc.).
    const proto = rawReq.headers['sec-websocket-protocol'];
    if (typeof proto === 'string' && proto.trim()) {
      const parts = proto.split(',').map((p) => p.trim()).filter(Boolean);
      for (const p of parts) {
        if (p === DEVICE_SUBPROTOCOL) continue;
        // Anything else that looks like aios-device* or carries a token → reject.
        if (p.startsWith('aios-device') || p.length > 32) {
          return null;
        }
        // Unknown protocols: reject to avoid credential smuggling.
        return null;
      }
    }

    const auth = rawReq.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const t = auth.slice(7).trim();
      if (t) return t;
    }
    return null;
  }

  private async registerDevice(ws: WebSocket, deviceId: string) {
    const prev = this.deviceConns.get(deviceId);
    if (prev) {
      try {
        prev.ws.close(4000, 'replaced');
      } catch {
        /* ignore */
      }
      this.deviceConns.delete(deviceId);
    }

    const conn: DeviceConn = {
      id: ulid(),
      deviceId,
      ws,
      lastPong: Date.now(),
    };
    this.deviceConns.set(deviceId, conn);
    void touchDeviceLastSeen(deviceId);

    this.send(
      ws,
      this.frame('event', {
        topic: 'device.hello',
        seq: this.seq,
        payload: { connId: conn.id, deviceId },
      }),
    );

    ws.on('message', async (buf) => {
      let f: AwpFrame;
      try {
        f = JSON.parse(buf.toString());
      } catch {
        return this.send(ws, this.frame('err', { payload: { code: 'BAD_FRAME' } }));
      }
      if (f.kind === 'pong') {
        conn.lastPong = Date.now();
        void touchDeviceLastSeen(deviceId);
        return;
      }
      if (f.kind === 'ping') {
        conn.lastPong = Date.now();
        void touchDeviceLastSeen(deviceId);
        return this.send(ws, this.frame('pong', { reqId: f.id }));
      }
      if (f.kind === 'req') {
        return this.handleDeviceReq(conn, f);
      }
    });

    ws.on('close', () => {
      const cur = this.deviceConns.get(deviceId);
      if (cur?.id === conn.id) this.deviceConns.delete(deviceId);
    });
    ws.on('error', () => {
      const cur = this.deviceConns.get(deviceId);
      if (cur?.id === conn.id) this.deviceConns.delete(deviceId);
    });
  }

  private async handleDeviceReq(conn: DeviceConn, f: AwpFrame) {
    const topic = f.topic ?? '';
    const payload: any = f.payload ?? {};
    try {
      if (topic === 'device.hello' || topic === 'hello') {
        if (payload?.capabilities) {
          try {
            await updateDeviceCapabilities(conn.deviceId, payload.capabilities);
          } catch (e) {
            return this.send(
              conn.ws,
              this.frame('err', {
                reqId: f.id,
                topic,
                payload: {
                  code: 'BAD_CAPABILITIES',
                  message: e instanceof Error ? e.message : String(e),
                },
              }),
            );
          }
        }
        conn.lastPong = Date.now();
        void touchDeviceLastSeen(conn.deviceId);
        return this.send(
          conn.ws,
          this.frame('res', {
            reqId: f.id,
            topic,
            payload: { ok: true, deviceId: conn.deviceId },
          }),
        );
      }
      if (topic === 'device.capabilities') {
        DeviceCapabilitiesSchema.parse(payload);
        await updateDeviceCapabilities(conn.deviceId, payload);
        conn.lastPong = Date.now();
        return this.send(
          conn.ws,
          this.frame('res', {
            reqId: f.id,
            topic,
            payload: { ok: true },
          }),
        );
      }
      if (topic === 'device.heartbeat') {
        conn.lastPong = Date.now();
        void touchDeviceLastSeen(conn.deviceId);
        return this.send(
          conn.ws,
          this.frame('res', {
            reqId: f.id,
            topic,
            payload: { ok: true, ts: new Date().toISOString() },
          }),
        );
      }
      return this.send(
        conn.ws,
        this.frame('err', { reqId: f.id, payload: { code: 'NO_HANDLER', topic } }),
      );
    } catch (e) {
      this.send(
        conn.ws,
        this.frame('err', {
          reqId: f.id,
          topic,
          payload: {
            message: e instanceof Error ? e.message : String(e),
          },
        }),
      );
    }
  }

  attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true });
    // handleProtocols: only accept fixed "aios-device" (never echo secrets).
    const deviceWss = new WebSocketServer({
      noServer: true,
      handleProtocols(protocols) {
        if (protocols.has(DEVICE_SUBPROTOCOL)) return DEVICE_SUBPROTOCOL;
        // No subprotocol is fine (Bearer-only clients).
        return false;
      },
    });

    server.on('upgrade', async (rawReq, socket, head) => {
      const url = new URL(rawReq.url ?? '', 'http://localhost');

      if (url.pathname === '/device/ws') {
        const deviceToken = this.extractDeviceBearer(rawReq, url);
        if (!deviceToken) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        let deviceId: string;
        try {
          const device = await authenticateDeviceToken(deviceToken);
          deviceId = device.id;
        } catch {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        deviceWss.handleUpgrade(rawReq, socket, head, (ws) => this.registerDevice(ws, deviceId));
        return;
      }

      if (url.pathname !== '/ws') return;
      const token = url.searchParams.get('token') ?? '';
      let userId: string;
      let role: string;
      try {
        const claims = await verifyAccess(token);
        if (claims.scope) throw new Error('Scoped OAuth tokens cannot open the general WebSocket');
        userId = claims.sub;
        role = claims.role;
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(rawReq, socket, head, (ws) => this.register(ws, userId, role));
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
      for (const [deviceId, dc] of this.deviceConns) {
        if (now - dc.lastPong > HEARTBEAT_FRESH_MS) {
          dc.ws.terminate();
          this.deviceConns.delete(deviceId);
          continue;
        }
        this.send(dc.ws, this.frame('ping', {}));
      }
    }, 25_000);
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.conns.values()) c.ws.close();
    for (const dc of this.deviceConns.values()) dc.ws.close();
    this.deviceConns.clear();
  }

  get connectionCount() {
    return this.conns.size;
  }

  get deviceConnectionCount() {
    return this.deviceConns.size;
  }
}

export const hub = new Hub();

export function publishToDevice(deviceId: string, topic: string, payload: unknown): boolean {
  return hub.publishToDevice(deviceId, topic, payload);
}

export function isDeviceOnline(deviceId: string): boolean {
  return hub.isDeviceOnline(deviceId);
}

export function disconnectDevice(deviceId: string, code?: number, reason?: string): void {
  hub.disconnectDevice(deviceId, code, reason);
}
