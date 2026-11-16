import {
  EXAM_EVENT_TYPES,
  MONITORING_UNAVAILABLE_LABEL,
  REVIEW_LEVEL_LABELS,
  type ClientStatus,
  type ContestSummary,
  type EventSeverity,
  type TimelineEvent,
} from "@exam-guard/shared";
import type { EventFilters } from "./api";

export function localTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Converts a datetime-local input value to UTC, or nothing if empty. */
export function toUtc(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

export function severityLabel(severity: EventSeverity): string {
  return severity === "monitoring_unavailable"
    ? MONITORING_UNAVAILABLE_LABEL
    : REVIEW_LEVEL_LABELS[severity];
}

const STATUS_TEXT: Record<ClientStatus, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  not_paired: "Not paired",
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function SummaryView({
  summary,
  onSelect,
}: {
  summary: ContestSummary;
  onSelect: (candidateId: string) => void;
}) {
  const t = summary.thresholds;
  return (
    <section>
      <div className="stats">
        <Stat
          label="Registered candidates"
          value={summary.registered_candidates}
        />
        <Stat label="Active sessions" value={summary.active_sessions} />
        <Stat label="Disconnected agents" value={summary.disconnected_agents} />
        <Stat
          label="Sessions requiring review"
          value={summary.sessions_requiring_review}
        />
      </div>
      <p className="note">
        These are signals for human review, not proof of misconduct. High review
        priority means, within {t.window_minutes} minutes: {t.focus_losses}{" "}
        focus losses, {t.fullscreen_exits} fullscreen exits, or{" "}
        {t.external_apps} external application changes.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Started</th>
              <th>Session</th>
              <th>Extension</th>
              <th>Agent</th>
              <th>Flagged events</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {summary.sessions.map((session) => (
              <tr key={session.session_id}>
                <td>
                  <button
                    type="button"
                    className="link"
                    onClick={() => onSelect(session.candidate_id)}
                  >
                    {session.display_name ?? session.candidate_id}
                  </button>
                  <div className="muted">{session.candidate_id}</div>
                </td>
                <td>{localTime(session.started_at)}</td>
                <td>{session.ended_at ? "Ended" : "Active"}</td>
                <td>{STATUS_TEXT[session.extension_status]}</td>
                <td>{STATUS_TEXT[session.agent_status]}</td>
                <td>{session.flagged_events}</td>
                <td>
                  <span className={`badge ${session.review_level}`}>
                    {REVIEW_LEVEL_LABELS[session.review_level]}
                  </span>
                  {session.monitoring_unavailable && (
                    <span className="badge monitoring_unavailable">
                      {MONITORING_UNAVAILABLE_LABEL}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {summary.sessions.length === 0 && (
        <p className="note">No candidate has started a session yet.</p>
      )}
    </section>
  );
}

export function FilterBar({
  filters,
  onChange,
}: {
  filters: EventFilters;
  onChange: (filters: EventFilters) => void;
}) {
  return (
    <div className="filters">
      <label>
        Candidate
        <input
          value={filters.candidate_id ?? ""}
          onChange={(e) =>
            onChange({ ...filters, candidate_id: e.target.value })
          }
        />
      </label>
      <label>
        Event type
        <select
          value={filters.type ?? ""}
          onChange={(e) => onChange({ ...filters, type: e.target.value })}
        >
          <option value="">All</option>
          {EXAM_EVENT_TYPES.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </label>
      <label>
        From
        <input
          type="datetime-local"
          onChange={(e) =>
            onChange({ ...filters, from: toUtc(e.target.value) })
          }
        />
      </label>
      <label>
        To
        <input
          type="datetime-local"
          onChange={(e) => onChange({ ...filters, to: toUtc(e.target.value) })}
        />
      </label>
    </div>
  );
}

export function TimelineView({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="note">No events match these filters.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time (local)</th>
            <th>Candidate</th>
            <th>Event</th>
            <th>Source</th>
            <th>Review</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.event_id}>
              <td title={`Received ${localTime(event.received_at)}`}>
                {localTime(event.occurred_at)}
              </td>
              <td>{event.display_name ?? event.candidate_id}</td>
              <td>{event.type}</td>
              <td>{event.source}</td>
              <td>
                <span className={`badge ${event.severity}`}>
                  {severityLabel(event.severity)}
                </span>
              </td>
              <td className="details">{JSON.stringify(event.metadata)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
