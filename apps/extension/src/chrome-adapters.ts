import { TICK_ALARM, TICK_PERIOD_MINUTES } from "./config";
import type { BrowserApi } from "./monitor";
import type { KeyValueStore } from "./queue";
import type { MonitoringState } from "./types";

export const chromeStore: KeyValueStore = {
  async get<T>(key: string) {
    const items = await chrome.storage.local.get(key);
    return items[key] as T | undefined;
  },
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: (key) => chrome.storage.local.remove(key),
};

const BADGES: Record<MonitoringState, { text: string; color: string }> = {
  idle: { text: "OFF", color: "#6b7280" },
  active: { text: "ON", color: "#15803d" },
  attention: { text: "!", color: "#b45309" },
};

export const chromeBrowser: BrowserApi = {
  async getActiveTab() {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab?.id === undefined) {
      return null;
    }
    return { tabId: tab.id, windowId: tab.windowId };
  },
  async getWindowState(windowId) {
    try {
      const window = await chrome.windows.get(windowId);
      return window.state ?? null;
    } catch {
      return null;
    }
  },
  async setBadge(state) {
    const { text, color } = BADGES[state];
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  },
  async setTickAlarm(enabled) {
    if (!enabled) {
      await chrome.alarms.clear(TICK_ALARM);
      return;
    }
    if (!(await chrome.alarms.get(TICK_ALARM))) {
      await chrome.alarms.create(TICK_ALARM, {
        periodInMinutes: TICK_PERIOD_MINUTES,
      });
    }
  },
};
