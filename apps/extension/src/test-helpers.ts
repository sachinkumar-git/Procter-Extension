import type { ExamEvent } from "@exam-guard/shared";
import type { KeyValueStore } from "./queue";

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();

  get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key);
    return Promise.resolve(
      value === undefined ? undefined : (JSON.parse(value) as T),
    );
  }

  set(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.stringify(value));
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}

export function makeEvent(id: string): ExamEvent {
  return {
    event_id: id,
    contest_id: "contest",
    session_id: "session",
    type: "TAB_CREATED",
    occurred_at: "2026-11-09T00:00:00.000Z",
    source: "extension",
  };
}
