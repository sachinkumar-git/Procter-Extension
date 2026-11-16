import { describe, expect, it } from "vitest";
import { EVENT_SOURCES, EXAM_EVENT_TYPES } from "./index.js";

describe("event contract", () => {
  it("defines the 16 event types from the README without duplicates", () => {
    expect(EXAM_EVENT_TYPES).toHaveLength(16);
    expect(new Set(EXAM_EVENT_TYPES).size).toBe(EXAM_EVENT_TYPES.length);
  });

  it("defines the three event sources", () => {
    expect([...EVENT_SOURCES]).toEqual([
      "extension",
      "windows-agent",
      "server",
    ]);
  });
});
