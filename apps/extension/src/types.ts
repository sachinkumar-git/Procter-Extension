import type { ExamEvent, ExamEventType } from "@exam-guard/shared";

export type FocusTarget = "exam" | "other_chrome_window" | "outside_chrome";

export interface Session {
  session_id: string;
  contest_id: string;
  candidate_id: string;
  started_at: string;
  /** Null once the exam tab has closed or a browser restart invalidated it. */
  exam_tab_id: number | null;
  exam_window_id: number | null;
  focus: FocusTarget;
  window_state: string | null;
  /** Set while the server cannot be reached; cleared on reconnection. */
  offline_since: string | null;
  auth_expired: boolean;
}

export type StoredTokens = Record<
  string,
  { token: string; expires_at: string }
>;

export type ConnectionState = "online" | "offline" | "auth_expired";

export type MonitoringState = "idle" | "active" | "attention";

export interface QueueState {
  events: ExamEvent[];
  /** Oldest events discarded because the local limit was reached. */
  dropped: number;
  attempts: number;
  next_attempt_ms: number;
  last_error: string | null;
  last_delivered_at: string | null;
}

export interface RecentEvent {
  event_id: string;
  type: ExamEventType;
  occurred_at: string;
}

export interface StatusView {
  monitoring: MonitoringState;
  session: Pick<
    Session,
    "session_id" | "contest_id" | "candidate_id" | "started_at"
  > | null;
  focus: FocusTarget | null;
  browser_fullscreen: boolean | null;
  queued: number;
  dropped: number;
  connection: ConnectionState;
  upload_error: string | null;
  recent: RecentEvent[];
}

export type ExtensionRequest =
  | { type: "status" }
  | {
      type: "start";
      contest_id: string;
      candidate_id: string;
      access_code: string;
      acknowledged: boolean;
    }
  | { type: "end" }
  | { type: "pairing" };

export type ExtensionResponse =
  | { ok: true; status: StatusView; pairing_code?: string }
  | { ok: false; error: string };
