import { createApiClient } from "./api-client";
import { chromeBrowser, chromeStore } from "./chrome-adapters";
import { TICK_ALARM } from "./config";
import { Monitor } from "./monitor";
import { createApiTransport } from "./transport";
import type { ExtensionRequest, ExtensionResponse } from "./types";

const api = createApiClient(
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000",
);

const monitor = new Monitor({
  store: chromeStore,
  browser: chromeBrowser,
  transport: createApiTransport(api, chromeStore),
  api,
  now: () => new Date(),
  uuid: () => crypto.randomUUID(),
  random: Math.random,
  version: chrome.runtime.getManifest().version,
});

function guard(task: Promise<unknown>): void {
  task.catch((error: unknown) => {
    console.error("Exam Guard monitoring error", error);
  });
}

async function handleRequest(
  request: ExtensionRequest,
): Promise<ExtensionResponse> {
  if (request.type === "pairing") {
    const result = await monitor.requestPairingCode();
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      status: await monitor.getStatus(),
      pairing_code: result.pairing_code,
    };
  }
  if (request.type === "start" || request.type === "end") {
    const result =
      request.type === "start"
        ? await monitor.startSession(request)
        : await monitor.endSession();
    if (!result.ok) {
      return result;
    }
  } else if (request.type !== "status") {
    return { ok: false, error: "Unknown request." };
  }
  return { ok: true, status: await monitor.getStatus() };
}

// MV3 requires listeners to be registered synchronously at the top level so
// that Chrome can wake a suspended service worker for them.
chrome.tabs.onActivated.addListener(({ tabId, windowId }) =>
  guard(monitor.handleTabActivated(tabId, windowId)),
);
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) {
    guard(monitor.handleTabCreated(tab.id, tab.windowId, tab.openerTabId));
  }
});
chrome.tabs.onRemoved.addListener((tabId) =>
  guard(monitor.handleTabRemoved(tabId)),
);
chrome.tabs.onAttached.addListener((tabId, info) =>
  guard(monitor.handleTabAttached(tabId, info.newWindowId)),
);
chrome.windows.onFocusChanged.addListener((windowId) =>
  guard(monitor.handleFocusChanged(windowId)),
);
chrome.windows.onBoundsChanged.addListener((window) => {
  if (window.id !== undefined) {
    guard(monitor.handleWindowBoundsChanged(window.id));
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) {
    guard(monitor.handleTick());
  }
});
chrome.runtime.onStartup.addListener(() =>
  guard(monitor.handleBrowserStartup()),
);
chrome.runtime.onInstalled.addListener(() => guard(monitor.restore()));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    return false;
  }
  handleRequest(message as ExtensionRequest)
    .then(sendResponse)
    .catch((error: unknown) => {
      console.error("Exam Guard request failed", error);
      sendResponse({ ok: false, error: "The request failed." });
    });
  return true;
});
