import type { ExamEvent } from "@exam-guard/shared";
import { ApiError, type SessionApi } from "./api-client";
import type { KeyValueStore } from "./queue";
import type { Session, StoredTokens } from "./types";

export type SendResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** The events can never be accepted and would block the queue. */
      undeliverable?: boolean;
    };

export interface EventTransport {
  send(events: ExamEvent[]): Promise<SendResult>;
}

/** Each batch holds one session's events and uses that session's token. */
export function createApiTransport(
  api: SessionApi,
  store: KeyValueStore,
): EventTransport {
  return {
    async send(events) {
      const sessionId = events[0]?.session_id ?? "";
      const tokens = (await store.get<StoredTokens>("tokens")) ?? {};
      const credential = tokens[sessionId];
      if (!credential) {
        return { ok: false, error: "missing_token", undeliverable: true };
      }
      try {
        const result = await api.sendEvents(credential.token, events);
        if (result.rejected.length > 0) {
          console.warn("Exam Guard: server rejected events", result.rejected);
        }
        return { ok: true };
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 0;
        const current = await store.get<Session>("session");
        return {
          ok: false,
          error: error instanceof Error ? error.message : "send_failed",
          // The current session stays queued so an invigilator can resolve it.
          undeliverable: status === 401 && current?.session_id !== sessionId,
        };
      }
    },
  };
}
