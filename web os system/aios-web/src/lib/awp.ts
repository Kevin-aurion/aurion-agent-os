'use client';
// AWP/1 WebSocket client hook. Connects to the backend hub, subscribes to
// topics, auto-reconnects with backoff, resumes via lastSeq, and answers pings.
import { useEffect, useRef, useState, useCallback } from 'react';
import { tokens } from './api';

export interface AwpFrame {
  v: 1;
  id: string;
  kind: 'req' | 'res' | 'event' | 'ping' | 'pong' | 'err';
  topic?: string;
  reqId?: string;
  seq?: number;
  ts: string;
  payload?: any;
}

type Listener = (frame: AwpFrame) => void;

export function useAwp(topics: string[], onEvent?: Listener) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);
  const backoffRef = useRef(1000);
  const topicsRef = useRef(topics);
  const onEventRef = useRef(onEvent);
  topicsRef.current = topics;
  onEventRef.current = onEvent;

  const send = useCallback((f: Partial<AwpFrame>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), ts: new Date().toISOString(), ...f }));
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const access = tokens.access;
      if (!access) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // Connect directly to the backend WS (Next rewrites don't proxy upgrades).
      const host = location.hostname;
      const ws = new WebSocket(`${proto}://${host}:8700/ws?token=${encodeURIComponent(access)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        backoffRef.current = 1000;
        send({ kind: 'req', topic: 'sub', payload: { topics: topicsRef.current, lastSeq: lastSeqRef.current } });
      };
      ws.onmessage = (ev) => {
        const f = JSON.parse(ev.data) as AwpFrame;
        if (f.kind === 'ping') return send({ kind: 'pong', reqId: f.id });
        if (typeof f.seq === 'number') lastSeqRef.current = Math.max(lastSeqRef.current, f.seq);
        if (f.kind === 'event') onEventRef.current?.(f);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        reconnectTimer = setTimeout(connect, backoffRef.current);
        backoffRef.current = Math.min(backoffRef.current * 2, 10000);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-subscribe when the topic list changes.
  useEffect(() => {
    send({ kind: 'req', topic: 'sub', payload: { topics, lastSeq: lastSeqRef.current } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topics.join(',')]);

  return { connected, send };
}
