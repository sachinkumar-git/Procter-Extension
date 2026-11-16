import { describe, expect, it } from "vitest";
import { csvField, csvRow } from "./csv.js";
import { reviewLevel, severityFor } from "./review.js";

const thresholds = {
  window_minutes: 10,
  focus_losses: 3,
  fullscreen_exits: 2,
  external_apps: 2,
};

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute));
const focus = (minute: number) => ({
  type: "BROWSER_FOCUS_LOST",
  occurred_at: at(minute),
});

describe("severityFor", () => {
  it("does not flag returning to the exam tab or approved browser", () => {
    expect(severityFor("TAB_ACTIVATED", { is_exam_tab: true })).toBe(
      "information",
    );
    expect(
      severityFor("FOREGROUND_APP_CHANGED", { is_approved_browser: true }),
    ).toBe("information");
  });

  it("flags leaving the exam, and treats outages separately", () => {
    expect(severityFor("TAB_ACTIVATED", { is_exam_tab: false })).toBe(
      "needs_review",
    );
    expect(severityFor("BROWSER_FOCUS_LOST", {})).toBe("needs_review");
    expect(severityFor("AGENT_DISCONNECTED", {})).toBe(
      "monitoring_unavailable",
    );
    expect(severityFor("AGENT_HEARTBEAT", {})).toBe("information");
  });
});

describe("reviewLevel", () => {
  it("is information with no flagged events", () => {
    expect(reviewLevel([], thresholds)).toBe("information");
  });

  it("never gives a single event high priority", () => {
    expect(reviewLevel([focus(1)], thresholds)).toBe("needs_review");
  });

  it("raises priority only when repeats fall inside the window", () => {
    expect(reviewLevel([focus(1), focus(4), focus(9)], thresholds)).toBe(
      "high_review_priority",
    );
    expect(reviewLevel([focus(1), focus(20), focus(40)], thresholds)).toBe(
      "needs_review",
    );
  });

  it("respects configured thresholds", () => {
    expect(
      reviewLevel([focus(1), focus(2), focus(3)], {
        ...thresholds,
        focus_losses: 4,
      }),
    ).toBe("needs_review");
  });
});

describe("csv", () => {
  it("escapes quotes and neutralises formulas", () => {
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvRow([null, 1])).toBe('"","1"\r\n');
  });
});
