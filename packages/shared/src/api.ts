// Types for the HTTP API shared by the API server, extension, and dashboard.

export type ReviewLevel =
  "information" | "needs_review" | "high_review_priority";

/** Wording deliberately avoids claiming that an event proves misconduct. */
export const REVIEW_LEVEL_LABELS: Record<ReviewLevel, string> = {
  information: "Information",
  needs_review: "Needs review",
  high_review_priority: "High review priority",
};

export const MONITORING_UNAVAILABLE_LABEL = "Monitoring unavailable";

export type EventSeverity = ReviewLevel | "monitoring_unavailable";

export type ClientStatus = "connected" | "disconnected" | "not_paired";

export interface ReviewThresholds {
  window_minutes: number;
  focus_losses: number;
  fullscreen_exits: number;
  external_apps: number;
}

export interface StartSessionResponse {
  session_id: string;
  token: string;
  expires_at: string;
}

export interface PairingCodeResponse {
  pairing_code: string;
  expires_at: string;
}

export interface HeartbeatResponse {
  session_active: boolean;
  server_time: string;
}

export interface BatchResponse {
  accepted: number;
  duplicates: number;
  rejected: { event_id: string | null; reason: string }[];
}

export interface ContestListItem {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  status: string;
}

export interface SessionSummary {
  session_id: string;
  candidate_id: string;
  display_name: string | null;
  started_at: string;
  ended_at: string | null;
  extension_status: ClientStatus;
  agent_status: ClientStatus;
  review_level: ReviewLevel;
  flagged_events: number;
  monitoring_unavailable: boolean;
}

export interface ContestSummary {
  contest: ContestListItem;
  registered_candidates: number;
  active_sessions: number;
  disconnected_agents: number;
  sessions_requiring_review: number;
  thresholds: ReviewThresholds;
  sessions: SessionSummary[];
}

export interface TimelineEvent {
  event_id: string;
  session_id: string;
  candidate_id: string;
  display_name: string | null;
  type: string;
  occurred_at: string;
  received_at: string;
  source: string;
  severity: EventSeverity;
  metadata: Record<string, string | number | boolean | null>;
}

export interface LoginResponse {
  token: string;
  expires_at: string;
  role: "admin" | "viewer";
}
