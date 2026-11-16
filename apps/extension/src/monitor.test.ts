import { EXAM_EVENT_TYPES, type ExamEvent } from "@exam-guard/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WINDOW_ID_NONE } from "./config";
import { Monitor, type BrowserApi } from "./monitor";
import { MemoryStore } from "./test-helpers";
import { ApiError, type SessionApi } from "./api-client";
import type { QueueState } from "./types";

const EXAM_TAB = 10;
const EXAM_WINDOW = 1;
const OTHER_WINDOW = 2;
const VALID = {
  contest_id: "contest-1",
  candidate_id: "cand_7",
  access_code: "CODE1234",
  acknowledged: true,
};

let store: MemoryStore;
let windowState: string | null;
let api: { [K in keyof SessionApi]: ReturnType<typeof vi.fn> };
let browser: { [K in keyof BrowserApi]: ReturnType<typeof vi.fn> };
let monitor: Monitor;
let sequence: number;

async function events(): Promise<ExamEvent[]> {
  return (await store.get<QueueState>("queue_state"))?.events ?? [];
}

async function types(): Promise<string[]> {
  return (await events()).map((event) => event.type);
}

async function last(): Promise<ExamEvent> {
  return (await events()).at(-1)!;
}

function createMonitor(): Monitor {
  return new Monitor({
    store,
    browser: browser as unknown as BrowserApi,
    // Failing delivery keeps events in the queue for inspection.
    transport: {
      send: () => Promise.resolve({ ok: false, error: "offline" }),
    },
    api: api as unknown as SessionApi,
    now: () => new Date(Date.UTC(2026, 10, 9, 12, 0, sequence)),
    uuid: () => `id-${++sequence}`,
    random: () => 0,
    version: "0.1.0",
  });
}

beforeEach(() => {
  store = new MemoryStore();
  windowState = "normal";
  sequence = 0;
  browser = {
    getActiveTab: vi.fn(() =>
      Promise.resolve({ tabId: EXAM_TAB, windowId: EXAM_WINDOW }),
    ),
    getWindowState: vi.fn(() => Promise.resolve(windowState)),
    setBadge: vi.fn(() => Promise.resolve()),
    setTickAlarm: vi.fn(() => Promise.resolve()),
  };
  api = {
    startSession: vi.fn(() =>
      Promise.resolve({
        session_id: "server-session",
        token: "tok",
        expires_at: "2026-11-09T16:00:00.000Z",
      }),
    ),
    heartbeat: vi.fn(() =>
      Promise.resolve({ session_active: true, server_time: "" }),
    ),
    endSession: vi.fn(() => Promise.resolve()),
    createPairingCode: vi.fn(() =>
      Promise.resolve({ pairing_code: "PAIRCODE", expires_at: "" }),
    ),
    sendEvents: vi.fn(),
  };
  monitor = createMonitor();
});

describe("session workflow", () => {
  it("records no events before a session starts", async () => {
    await monitor.handleTabActivated(5, EXAM_WINDOW);
    await monitor.handleFocusChanged(WINDOW_ID_NONE);
    expect(await types()).toEqual([]);
    expect((await monitor.getStatus()).monitoring).toBe("idle");
  });

  it("starts a session on the active tab with a contract-valid event", async () => {
    windowState = "fullscreen";
    expect(await monitor.startSession(VALID)).toEqual({ ok: true });

    const event = await last();
    expect(event.type).toBe("SESSION_STARTED");
    expect(event.source).toBe("extension");
    expect(event.contest_id).toBe("contest-1");
    expect(event.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
    expect(event.metadata).toMatchObject({
      candidate_id: "cand_7",
      exam_tab_id: EXAM_TAB,
      browser_fullscreen: true,
    });
    expect((await monitor.getStatus()).monitoring).toBe("active");
    expect(browser.setBadge).toHaveBeenLastCalledWith("active");
    expect(browser.setTickAlarm).toHaveBeenLastCalledWith(true);
  });

  it.each([
    [{ ...VALID, acknowledged: false }, "acknowledge"],
    [{ ...VALID, contest_id: "  " }, "IDs must be"],
    [{ ...VALID, candidate_id: "bad id!" }, "IDs must be"],
  ])("rejects invalid input %#", async (input, message) => {
    const result = await monitor.startSession(input);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(message),
    });
    expect(await types()).toEqual([]);
  });

  it("rejects a second session and a start with no identifiable tab", async () => {
    browser.getActiveTab.mockResolvedValueOnce(null);
    expect((await monitor.startSession(VALID)).ok).toBe(false);

    await monitor.startSession(VALID);
    expect((await monitor.startSession(VALID)).ok).toBe(false);
    expect(await types()).toEqual(["SESSION_STARTED"]);
  });

  it("ends the session and keeps undelivered events for retry", async () => {
    await monitor.startSession(VALID);
    expect(await monitor.endSession()).toEqual({ ok: true });

    expect(await types()).toEqual(["SESSION_STARTED", "SESSION_ENDED"]);
    expect((await monitor.getStatus()).monitoring).toBe("idle");
    expect(browser.setBadge).toHaveBeenLastCalledWith("idle");
    expect(api.endSession).toHaveBeenCalledWith("tok");
    expect(browser.setTickAlarm).toHaveBeenLastCalledWith(true);

    await monitor.handleTabCreated(11, EXAM_WINDOW, undefined);
    expect(await types()).toHaveLength(2);
  });
});

describe("server connection", () => {
  beforeEach(() => monitor.startSession(VALID));

  it("uses the server's session ID", async () => {
    expect((await last()).session_id).toBe("server-session");
  });

  it("never stores the access code", () => {
    expect([...store.data.values()].join()).not.toContain("CODE1234");
  });

  it("records one reconnection after an outage", async () => {
    api.heartbeat.mockRejectedValueOnce(new ApiError(0, "network_error"));
    api.heartbeat.mockRejectedValueOnce(new ApiError(0, "network_error"));
    await monitor.handleTick();
    await monitor.handleTick();
    expect((await monitor.getStatus()).connection).toBe("offline");

    await monitor.handleTick();
    await monitor.handleTick();

    expect(await types()).toEqual(["SESSION_STARTED", "NETWORK_RECONNECTED"]);
    expect((await monitor.getStatus()).connection).toBe("online");
  });

  it("flags attention when the credential is rejected", async () => {
    api.heartbeat.mockRejectedValueOnce(new ApiError(401, "invalid_token"));
    await monitor.handleTick();
    const status = await monitor.getStatus();
    expect(status.connection).toBe("auth_expired");
    expect(status.monitoring).toBe("attention");
  });

  it("stops when the server has closed the session", async () => {
    api.heartbeat.mockResolvedValueOnce({
      session_active: false,
      server_time: "",
    });
    await monitor.handleTick();
    expect((await monitor.getStatus()).monitoring).toBe("idle");
  });

  it("returns a pairing code for the active session", async () => {
    expect(await monitor.requestPairingCode()).toEqual({
      ok: true,
      pairing_code: "PAIRCODE",
    });
  });
});

describe("starting against the server", () => {
  it.each([
    [401, "incorrect"],
    [403, "not open"],
    [0, "Cannot reach"],
  ])("explains a %i response without starting", async (status, message) => {
    api.startSession.mockRejectedValueOnce(new ApiError(status, "x"));
    const result = await monitor.startSession(VALID);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(message),
    });
    expect((await monitor.getStatus()).monitoring).toBe("idle");
  });
});

describe("tab events", () => {
  beforeEach(() => monitor.startSession(VALID));

  it("records a tab switch and whether it is the exam tab", async () => {
    await monitor.handleTabActivated(99, EXAM_WINDOW);
    expect((await last()).type).toBe("TAB_ACTIVATED");
    expect((await last()).metadata).toMatchObject({
      tab_id: 99,
      is_exam_tab: false,
      detection: "chrome_event",
    });

    await monitor.handleTabActivated(EXAM_TAB, EXAM_WINDOW);
    expect((await last()).metadata).toMatchObject({ is_exam_tab: true });
  });

  it("records a new tab and whether the exam tab opened it", async () => {
    await monitor.handleTabCreated(20, EXAM_WINDOW, EXAM_TAB);
    expect((await last()).type).toBe("TAB_CREATED");
    expect((await last()).metadata).toMatchObject({
      opened_from_exam_tab: true,
    });

    await monitor.handleTabCreated(21, EXAM_WINDOW, undefined);
    expect((await last()).metadata).toMatchObject({
      opened_from_exam_tab: false,
    });
  });

  it("flags attention when the exam tab closes", async () => {
    await monitor.handleTabRemoved(77);
    expect((await monitor.getStatus()).monitoring).toBe("active");

    await monitor.handleTabRemoved(EXAM_TAB);
    expect((await monitor.getStatus()).monitoring).toBe("attention");
    expect(browser.setBadge).toHaveBeenLastCalledWith("attention");

    await monitor.handleTabActivated(30, EXAM_WINDOW);
    expect((await last()).metadata).toMatchObject({
      is_exam_tab: false,
      exam_tab_open: false,
    });
  });

  it("follows the exam tab when it moves to another window", async () => {
    await monitor.handleTabAttached(EXAM_TAB, OTHER_WINDOW);
    await monitor.handleFocusChanged(OTHER_WINDOW);
    expect(await types()).toEqual(["SESSION_STARTED"]);
  });
});

describe("focus events", () => {
  beforeEach(() => monitor.startSession(VALID));

  it("records focus leaving Chrome and returning", async () => {
    await monitor.handleFocusChanged(WINDOW_ID_NONE);
    expect((await last()).type).toBe("BROWSER_FOCUS_LOST");
    expect((await last()).metadata).toMatchObject({
      focus_target: "outside_chrome",
    });

    await monitor.handleFocusChanged(EXAM_WINDOW);
    expect((await last()).type).toBe("BROWSER_FOCUS_RETURNED");
    expect((await last()).metadata).toMatchObject({
      previous_focus: "outside_chrome",
    });
  });

  it("treats another Chrome window as leaving the exam window", async () => {
    await monitor.handleFocusChanged(OTHER_WINDOW);
    expect((await last()).metadata).toMatchObject({
      focus_target: "other_chrome_window",
    });
  });

  it("reports one loss per excursion", async () => {
    await monitor.handleFocusChanged(WINDOW_ID_NONE);
    await monitor.handleFocusChanged(OTHER_WINDOW);
    await monitor.handleFocusChanged(WINDOW_ID_NONE);
    expect(await types()).toEqual(["SESSION_STARTED", "BROWSER_FOCUS_LOST"]);
  });

  it("does not report a return for focus already on the exam window", async () => {
    await monitor.handleFocusChanged(EXAM_WINDOW);
    expect(await types()).toEqual(["SESSION_STARTED"]);
  });
});

describe("browser fullscreen state", () => {
  beforeEach(() => monitor.startSession(VALID));

  it("records entering and exiting as browser-window observations", async () => {
    windowState = "fullscreen";
    await monitor.handleWindowBoundsChanged(EXAM_WINDOW);
    expect((await last()).type).toBe("FULLSCREEN_ENTERED");
    expect((await last()).metadata).toMatchObject({
      scope: "browser_window",
      detection: "window_state_event",
    });

    windowState = "normal";
    await monitor.handleWindowBoundsChanged(EXAM_WINDOW);
    expect((await last()).type).toBe("FULLSCREEN_EXITED");
  });

  it("marks changes found by the periodic check as polled", async () => {
    windowState = "fullscreen";
    await monitor.handleTick();
    expect((await last()).metadata).toMatchObject({
      detection: "window_state_poll",
    });
  });

  it("ignores other windows and non-fullscreen state changes", async () => {
    windowState = "fullscreen";
    await monitor.handleWindowBoundsChanged(OTHER_WINDOW);
    expect(await types()).toEqual(["SESSION_STARTED"]);

    windowState = "maximized";
    await monitor.handleTick();
    expect(await types()).toEqual(["SESSION_STARTED"]);
  });

  it("does not repeat an event for an unchanged state", async () => {
    windowState = "fullscreen";
    await monitor.handleTick();
    await monitor.handleTick();
    await monitor.handleWindowBoundsChanged(EXAM_WINDOW);
    expect(await types()).toEqual(["SESSION_STARTED", "FULLSCREEN_ENTERED"]);
  });

  it("does not invent an event when the window cannot be read", async () => {
    windowState = null;
    await monitor.handleTick();
    expect(await types()).toEqual(["SESSION_STARTED"]);
  });
});

describe("reliability and data minimisation", () => {
  it("keeps every event when Chrome delivers them concurrently", async () => {
    await monitor.startSession(VALID);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        monitor.handleTabCreated(100 + i, EXAM_WINDOW, undefined),
      ),
    );

    const all = await events();
    expect(all).toHaveLength(51);
    expect(new Set(all.map((event) => event.event_id)).size).toBe(51);
  });

  it("continues working after an operation fails", async () => {
    await monitor.startSession(VALID);
    const set = vi.spyOn(store, "set");
    set.mockRejectedValueOnce(new Error("quota"));
    await expect(
      monitor.handleTabCreated(1, EXAM_WINDOW, undefined),
    ).rejects.toThrow("quota");

    await monitor.handleTabCreated(2, EXAM_WINDOW, undefined);
    expect((await last()).metadata).toMatchObject({ tab_id: 2 });
  });

  it("resumes a session after the service worker restarts", async () => {
    await monitor.startSession(VALID);

    const restarted = createMonitor();
    await restarted.handleFocusChanged(WINDOW_ID_NONE);

    expect((await last()).type).toBe("BROWSER_FOCUS_LOST");
    expect((await restarted.getStatus()).session?.contest_id).toBe("contest-1");
  });

  it("flags attention after a browser restart invalidates tab IDs", async () => {
    await monitor.startSession(VALID);
    await monitor.handleBrowserStartup();
    expect((await monitor.getStatus()).monitoring).toBe("attention");
    expect(browser.setTickAlarm).toHaveBeenLastCalledWith(true);
  });

  it("emits only supported event types and no page data", async () => {
    await monitor.startSession(VALID);
    await monitor.handleTabActivated(2, EXAM_WINDOW);
    await monitor.handleTabCreated(3, EXAM_WINDOW, undefined);
    await monitor.handleFocusChanged(WINDOW_ID_NONE);
    await monitor.handleFocusChanged(EXAM_WINDOW);
    windowState = "fullscreen";
    await monitor.handleTick();
    windowState = "normal";
    await monitor.handleTick();
    await monitor.endSession();

    const all = await events();
    expect(all).toHaveLength(8);
    for (const event of all) {
      expect(EXAM_EVENT_TYPES).toContain(event.type);
      expect(event.type).not.toMatch(/EXAM_TAB_(HIDDEN|VISIBLE)/);
      expect(Object.keys(event.metadata ?? {}).join()).not.toMatch(
        /url|title|content|severity/i,
      );
    }
  });
});
