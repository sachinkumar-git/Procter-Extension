import type { ExamEvent } from "@exam-guard/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionResponse, QueueState } from "./types";

type Listener = (...args: unknown[]) => unknown;

function makeEvent() {
  const listeners: Listener[] = [];
  return {
    addListener: (listener: Listener) => listeners.push(listener),
    fire: (...args: unknown[]) => listeners.map((l) => l(...args)),
  };
}

const storage: Record<string, unknown> = {};
const fake = {
  tabs: {
    onActivated: makeEvent(),
    onCreated: makeEvent(),
    onRemoved: makeEvent(),
    onAttached: makeEvent(),
    query: vi.fn(async () => [{ id: 10, windowId: 1 }]),
  },
  windows: {
    onFocusChanged: makeEvent(),
    onBoundsChanged: makeEvent(),
    get: vi.fn(async () => ({ state: "normal" })),
  },
  alarms: {
    onAlarm: makeEvent(),
    get: vi.fn(async () => undefined),
    create: vi.fn(async () => undefined),
    clear: vi.fn(async () => true),
  },
  action: {
    setBadgeText: vi.fn(async () => undefined),
    setBadgeBackgroundColor: vi.fn(async () => undefined),
  },
  runtime: {
    id: "self",
    getManifest: () => ({ version: "0.1.0" }),
    onStartup: makeEvent(),
    onInstalled: makeEvent(),
    onMessage: makeEvent(),
  },
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(storage, structuredClone(items));
      }),
      remove: vi.fn(async (key: string) => {
        delete storage[key];
      }),
    },
  },
};

function request(message: unknown, senderId = "self") {
  return new Promise<ExtensionResponse>((resolve) => {
    fake.runtime.onMessage.fire(message, { id: senderId }, resolve);
  });
}

function storedEvents(): ExamEvent[] {
  return (storage.queue_state as QueueState | undefined)?.events ?? [];
}

beforeAll(async () => {
  vi.stubGlobal("chrome", fake);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/v1/sessions")
        ? new Response(
            JSON.stringify({
              session_id: "srv",
              token: "tok",
              expires_at: "2030-01-01T00:00:00.000Z",
            }),
            { status: 201 },
          )
        : new Response("{}", { status: 503 }),
    ),
  );
  await import("./background");
});

describe("service worker wiring", () => {
  it("rejects messages from another extension", () => {
    const respond = vi.fn();
    const [handled] = fake.runtime.onMessage.fire(
      { type: "status" },
      { id: "other" },
      respond,
    );
    expect(handled).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });

  it("rejects unknown requests", async () => {
    expect(await request({ type: "wipe" })).toEqual({
      ok: false,
      error: "Unknown request.",
    });
  });

  it("drives a session from Chrome events to local storage", async () => {
    const started = await request({
      type: "start",
      contest_id: "c1",
      candidate_id: "s1",
      access_code: "CODE1234",
      acknowledged: true,
    });
    expect(started).toMatchObject({
      ok: true,
      status: { monitoring: "active", connection: "online" },
    });
    expect(fake.action.setBadgeText).toHaveBeenLastCalledWith({ text: "ON" });
    expect(fake.alarms.create).toHaveBeenCalledOnce();

    fake.tabs.onActivated.fire({ tabId: 5, windowId: 1 });
    fake.tabs.onCreated.fire({ id: 6, windowId: 1 });
    fake.windows.onFocusChanged.fire(-1);
    await request({ type: "status" });

    expect(storedEvents().map((event) => event.type)).toEqual([
      "SESSION_STARTED",
      "TAB_ACTIVATED",
      "TAB_CREATED",
      "BROWSER_FOCUS_LOST",
    ]);
  });
});
