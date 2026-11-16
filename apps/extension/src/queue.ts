import type { ExamEvent } from "@exam-guard/shared";
import {
  MAX_QUEUED_EVENTS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  UPLOAD_BATCH_SIZE,
} from "./config";
import type { EventTransport, SendResult } from "./transport";
import type { QueueState } from "./types";

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

const QUEUE_KEY = "queue_state";

function emptyState(): QueueState {
  return {
    events: [],
    dropped: 0,
    attempts: 0,
    next_attempt_ms: 0,
    last_error: null,
    last_delivered_at: null,
  };
}

/**
 * Durable event queue. Not safe for concurrent calls on its own: Monitor runs
 * every operation through one serialized chain.
 */
export class EventQueue {
  constructor(
    private readonly store: KeyValueStore,
    private readonly transport: EventTransport,
    private readonly nowMs: () => number,
    private readonly random: () => number,
  ) {}

  async read(): Promise<QueueState> {
    return (await this.store.get<QueueState>(QUEUE_KEY)) ?? emptyState();
  }

  async add(event: ExamEvent): Promise<void> {
    const state = await this.read();
    state.events.push(event);
    const excess = state.events.length - MAX_QUEUED_EVENTS;
    if (excess > 0) {
      state.events.splice(0, excess);
      state.dropped += excess;
    }
    await this.store.set(QUEUE_KEY, state);
  }

  /** Called when the server is known to be reachable again. */
  async resetBackoff(): Promise<void> {
    const state = await this.read();
    state.next_attempt_ms = 0;
    await this.store.set(QUEUE_KEY, state);
  }

  /** Sends queued events oldest first, stopping at the first failure. */
  async flush(): Promise<void> {
    const state = await this.read();
    if (this.nowMs() < state.next_attempt_ms) {
      return;
    }

    while (state.events.length > 0) {
      const firstSession = state.events[0]?.session_id;
      const batch = state.events
        .slice(0, UPLOAD_BATCH_SIZE)
        .filter((event) => event.session_id === firstSession);
      const result = await this.send(batch);

      if (!result.ok && result.undeliverable) {
        const ids = new Set(batch.map((event) => event.event_id));
        state.events = state.events.filter((e) => !ids.has(e.event_id));
        state.dropped += batch.length;
        state.last_error = result.error;
        await this.store.set(QUEUE_KEY, state);
        continue;
      }

      if (!result.ok) {
        state.attempts += 1;
        state.next_attempt_ms = this.nowMs() + this.backoffMs(state.attempts);
        state.last_error = result.error;
        await this.store.set(QUEUE_KEY, state);
        return;
      }

      const delivered = new Set(batch.map((event) => event.event_id));
      state.events = state.events.filter((e) => !delivered.has(e.event_id));
      state.attempts = 0;
      state.next_attempt_ms = 0;
      state.last_error = null;
      state.last_delivered_at = new Date(this.nowMs()).toISOString();
      await this.store.set(QUEUE_KEY, state);
    }
  }

  private async send(batch: ExamEvent[]): Promise<SendResult> {
    try {
      return await this.transport.send(batch);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "send_failed",
      };
    }
  }

  /** Jitter prevents a whole lab retrying in step after an outage. */
  private backoffMs(attempts: number): number {
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
    return ceiling * (0.5 + this.random() * 0.5);
  }
}
