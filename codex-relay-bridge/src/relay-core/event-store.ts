export type NormalizedEventType =
  | "turn_started"
  | "turn_completed"
  | "agent_message"
  | "agent_message_delta"
  | "item_started"
  | "item_completed"
  | "approval_requested"
  | "approval_resolved"
  | "error"
  | "protocol_violation"
  | "raw";

export interface NormalizedEvent {
  seq: number;
  ts: number;
  type: NormalizedEventType;
  turnId?: string;
  itemId?: string;
  text?: string;
  raw?: unknown;
  truncated?: boolean;
  gap?: boolean;
  requestId?: string;
  kind?: string;
  decision?: string;
}

const MAX_TEXT = 4000;
const MAX_EVENTS_PER_TASK = 5000;
const MAX_READ_EVENTS = 100;
const MAX_READ_BYTES = 50 * 1024;

export interface EventStoreDiagnostics {
  droppedEvents: number;
  unroutableNotifications: number;
  droppedBeforeSeq: Map<string, number>;
}

export class EventStore {
  private readonly events = new Map<string, NormalizedEvent[]>(); // taskId -> events
  private readonly nextSeq = new Map<string, number>();
  private droppedEvents = 0;
  private unroutableNotifications = 0;
  private readonly droppedBeforeSeq = new Map<string, number>();

  append(
    taskId: string,
    partial: Omit<NormalizedEvent, "seq" | "ts"> & { ts?: number },
  ): NormalizedEvent {
    let list = this.events.get(taskId);
    if (!list) {
      list = [];
      this.events.set(taskId, list);
    }
    const seq = this.nextSeq.get(taskId) ?? 0;
    this.nextSeq.set(taskId, seq + 1);

    let text = partial.text;
    let truncated = partial.truncated;
    if (text !== undefined && text.length > MAX_TEXT) {
      text = text.slice(0, MAX_TEXT);
      truncated = true;
    }

    const ev: NormalizedEvent = {
      seq,
      ts: partial.ts ?? Date.now(),
      type: partial.type,
      ...(partial.turnId !== undefined ? { turnId: partial.turnId } : {}),
      ...(partial.itemId !== undefined ? { itemId: partial.itemId } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(partial.raw !== undefined ? { raw: partial.raw } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(partial.gap ? { gap: true } : {}),
      ...(partial.requestId !== undefined ? { requestId: partial.requestId } : {}),
      ...(partial.kind !== undefined ? { kind: partial.kind } : {}),
      ...(partial.decision !== undefined ? { decision: partial.decision } : {}),
    };

    list.push(ev);

    while (list.length > MAX_EVENTS_PER_TASK) {
      const dropped = list.shift();
      if (dropped) {
        this.droppedEvents++;
        const prev = this.droppedBeforeSeq.get(taskId) ?? 0;
        this.droppedBeforeSeq.set(taskId, Math.max(prev, dropped.seq + 1));
      }
    }

    return ev;
  }

  recordUnroutable(): void {
    this.unroutableNotifications++;
  }

  read(
    taskId: string,
    cursor?: number,
  ): { events: NormalizedEvent[]; next_cursor: number; has_more: boolean } {
    const list = this.events.get(taskId) ?? [];
    const startSeq = cursor ?? 0;
    const droppedBefore = this.droppedBeforeSeq.get(taskId) ?? 0;

    let fromIdx = list.findIndex((e) => e.seq >= startSeq);
    if (fromIdx < 0) {
      // cursor beyond end or empty
      if (list.length === 0) {
        return { events: [], next_cursor: startSeq, has_more: false };
      }
      // all events are before cursor
      const last = list[list.length - 1]!;
      return { events: [], next_cursor: last.seq + 1, has_more: false };
    }

    const out: NormalizedEvent[] = [];
    let bytes = 0;
    let i = fromIdx;

    // Gap marker if cursor is before retained window
    if (startSeq < droppedBefore && list.length > 0) {
      const gapEv: NormalizedEvent = {
        seq: list[fromIdx]!.seq,
        ts: list[fromIdx]!.ts,
        type: "raw",
        gap: true,
        text: `gap: events before seq ${droppedBefore} were dropped`,
      };
      out.push(gapEv);
      bytes += JSON.stringify(gapEv).length;
    }

    while (i < list.length && out.length < MAX_READ_EVENTS) {
      const ev = list[i]!;
      const size = JSON.stringify(ev).length;
      if (out.length > 0 && bytes + size > MAX_READ_BYTES) break;
      out.push(ev);
      bytes += size;
      i++;
    }

    const lastSeq =
      out.length > 0
        ? Math.max(...out.map((e) => e.seq))
        : startSeq - 1;
    const next_cursor = lastSeq + 1;
    const has_more = i < list.length;

    return { events: out, next_cursor, has_more };
  }

  lastAgentMessage(taskId: string, maxLen = 500): string | null {
    const list = this.events.get(taskId) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (
        (e.type === "agent_message" || e.type === "agent_message_delta") &&
        e.text
      ) {
        return e.text.length > maxLen ? e.text.slice(0, maxLen) : e.text;
      }
    }
    return null;
  }

  diagnostics(): {
    dropped_events: number;
    unroutable_notifications: number;
  } {
    return {
      dropped_events: this.droppedEvents,
      unroutable_notifications: this.unroutableNotifications,
    };
  }
}

/**
 * Map a known ServerNotification into a normalized event type.
 * Returns null if the notification should only update state (no event),
 * or "raw" for known-but-unmapped methods.
 */
function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function withOpts(
  base: Omit<NormalizedEvent, "seq" | "ts">,
  opts: {
    turnId?: string | undefined;
    itemId?: string | undefined;
    text?: string | undefined;
  },
): Omit<NormalizedEvent, "seq" | "ts"> {
  return {
    ...base,
    ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
    ...(opts.itemId !== undefined ? { itemId: opts.itemId } : {}),
    ...(opts.text !== undefined ? { text: opts.text } : {}),
  };
}

export function mapNotificationToEvent(
  method: string,
  params: unknown,
): Omit<NormalizedEvent, "seq" | "ts"> | null {
  const p = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "turn/started": {
      const turn = p.turn as { id?: string } | undefined;
      return withOpts(
        { type: "turn_started", raw: params },
        { turnId: turn?.id ?? optStr(p.turnId) },
      );
    }
    case "turn/completed": {
      const turn = p.turn as { id?: string } | undefined;
      return withOpts(
        { type: "turn_completed", raw: params },
        { turnId: turn?.id ?? optStr(p.turnId) },
      );
    }
    case "item/agentMessage/delta": {
      return withOpts(
        { type: "agent_message_delta", raw: params },
        {
          turnId: optStr(p.turnId),
          itemId: optStr(p.itemId),
          text: typeof p.delta === "string" ? p.delta : undefined,
        },
      );
    }
    case "item/started": {
      const item = p.item as { id?: string; type?: string; text?: string } | undefined;
      return withOpts(
        { type: "item_started", raw: params },
        {
          turnId: optStr(p.turnId),
          itemId: item?.id,
          text: item?.type === "agentMessage" ? item.text : undefined,
        },
      );
    }
    case "item/completed": {
      const item = p.item as { id?: string; type?: string; text?: string } | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        return withOpts(
          { type: "agent_message", raw: params },
          {
            turnId: optStr(p.turnId),
            itemId: item.id,
            text: item.text,
          },
        );
      }
      return withOpts(
        { type: "item_completed", raw: params },
        {
          turnId: optStr(p.turnId),
          itemId: item?.id,
        },
      );
    }
    case "error": {
      return {
        type: "error",
        text: typeof p.message === "string" ? p.message : JSON.stringify(params),
        raw: params,
      };
    }
    default:
      return { type: "raw", raw: params, text: method };
  }
}

export function extractThreadId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const p = params as Record<string, unknown>;
  if (typeof p.threadId === "string") return p.threadId;
  if (typeof p.conversationId === "string") return p.conversationId;
  return undefined;
}
