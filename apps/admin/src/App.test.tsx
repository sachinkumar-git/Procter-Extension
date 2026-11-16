import type { ContestSummary, TimelineEvent } from "@exam-guard/shared";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { filterQuery } from "./api";
import { App } from "./App";
import { severityLabel, SummaryView, TimelineView, toUtc } from "./views";

const summary: ContestSummary = {
  contest: {
    id: "c1",
    name: "Mock",
    starts_at: "2026-11-09T10:00:00.000Z",
    ends_at: "2026-11-09T12:00:00.000Z",
    status: "active",
  },
  registered_candidates: 400,
  active_sessions: 2,
  disconnected_agents: 1,
  sessions_requiring_review: 1,
  thresholds: {
    window_minutes: 10,
    focus_losses: 3,
    fullscreen_exits: 2,
    external_apps: 2,
  },
  sessions: [
    {
      session_id: "s1",
      candidate_id: "cand-1",
      display_name: "Asha",
      started_at: "2026-11-09T10:00:00.000Z",
      ended_at: null,
      extension_status: "connected",
      agent_status: "disconnected",
      review_level: "high_review_priority",
      flagged_events: 4,
      monitoring_unavailable: true,
    },
  ],
};

const event: TimelineEvent = {
  event_id: "e1",
  session_id: "s1",
  candidate_id: "cand-1",
  display_name: "Asha",
  type: "BROWSER_FOCUS_LOST",
  occurred_at: "2026-11-09T10:00:00.000Z",
  received_at: "2026-11-09T10:00:01.000Z",
  source: "extension",
  severity: "needs_review",
  metadata: { focus_target: "outside_chrome" },
};

describe("App", () => {
  it("shows the sign-in form first", () => {
    const html = renderToString(<App />);
    expect(html).toContain("CodeWallah Exam Guard");
    expect(html).toContain("Sign in");
  });
});

describe("SummaryView", () => {
  const html = renderToString(
    <SummaryView summary={summary} onSelect={() => undefined} />,
  );

  it("shows the contest counts", () => {
    expect(html).toContain("Registered candidates");
    expect(html).toContain("400");
    expect(html).toContain("Disconnected agents");
  });

  it("uses review labels and shows outages separately", () => {
    expect(html).toContain("High review priority");
    expect(html).toContain("Monitoring unavailable");
  });

  it("shows thresholds and never claims proof", () => {
    expect(html).toContain("not proof of misconduct");
    expect(html.replace(/\s+/g, " ")).toContain("within");
    expect(html.toLowerCase()).not.toContain("cheat");
    expect(html.toLowerCase()).not.toContain("violation");
  });
});

describe("TimelineView", () => {
  it("renders events and labels", () => {
    const html = renderToString(<TimelineView events={[event]} />);
    expect(html).toContain("BROWSER_FOCUS_LOST");
    expect(html).toContain("Needs review");
  });

  it("explains an empty result", () => {
    expect(renderToString(<TimelineView events={[]} />)).toContain("No events");
  });
});

describe("helpers", () => {
  it("omits empty filters from the query", () => {
    expect(filterQuery({ candidate_id: "", type: "TAB_CREATED" })).toBe(
      "?type=TAB_CREATED",
    );
    expect(filterQuery({})).toBe("");
  });

  it("converts local input to UTC", () => {
    expect(toUtc("")).toBeUndefined();
    expect(toUtc("2026-11-09T10:00")).toMatch(/Z$/);
  });

  it("labels outages distinctly from review levels", () => {
    expect(severityLabel("monitoring_unavailable")).toBe(
      "Monitoring unavailable",
    );
    expect(severityLabel("needs_review")).toBe("Needs review");
  });
});
