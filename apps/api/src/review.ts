import type {
  EventSeverity,
  ExamEventType,
  ReviewLevel,
  ReviewThresholds,
} from "@exam-guard/shared";

type Metadata = Record<string, unknown> | undefined;

/** Transparent per-event rules from section 6 of the README. */
export function severityFor(
  type: ExamEventType,
  metadata: Metadata,
): EventSeverity {
  switch (type) {
    case "TAB_ACTIVATED":
      return metadata?.is_exam_tab === true ? "information" : "needs_review";
    case "FOREGROUND_APP_CHANGED":
      return metadata?.is_approved_browser === true
        ? "information"
        : "needs_review";
    case "TAB_CREATED":
    case "BROWSER_FOCUS_LOST":
    case "FULLSCREEN_EXITED":
    case "EXAM_TAB_HIDDEN":
      return "needs_review";
    case "AGENT_DISCONNECTED":
    case "EXTENSION_DISCONNECTED":
      return "monitoring_unavailable";
    default:
      return "information";
  }
}

export interface FlaggedEvent {
  type: string;
  occurred_at: Date;
}

function maxInWindow(times: number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end]! - times[start]! > windowMs) {
      start++;
    }
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/** Input must hold only `needs_review` events for a single session. */
export function reviewLevel(
  flagged: FlaggedEvent[],
  thresholds: ReviewThresholds,
): ReviewLevel {
  if (flagged.length === 0) {
    return "information";
  }
  const windowMs = thresholds.window_minutes * 60_000;
  const count = (type: string) =>
    maxInWindow(
      flagged
        .filter((event) => event.type === type)
        .map((event) => event.occurred_at.getTime())
        .sort((a, b) => a - b),
      windowMs,
    );

  const high =
    count("BROWSER_FOCUS_LOST") >= thresholds.focus_losses ||
    count("FULLSCREEN_EXITED") >= thresholds.fullscreen_exits ||
    count("FOREGROUND_APP_CHANGED") >= thresholds.external_apps;
  return high ? "high_review_priority" : "needs_review";
}
