import type {
  EventMetadata,
  ExamEvent,
  ExamEventType,
} from "@exam-guard/shared";
import { RECENT_EVENT_COUNT, WINDOW_ID_NONE } from "./config";
import { ApiError, type SessionApi } from "./api-client";
import { EventQueue, type KeyValueStore } from "./queue";
import type { EventTransport } from "./transport";
import type {
  FocusTarget,
  MonitoringState,
  Session,
  StatusView,
  StoredTokens,
} from "./types";

export interface ActiveTab {
  tabId: number;
  windowId: number;
}

export interface BrowserApi {
  getActiveTab(): Promise<ActiveTab | null>;
  /** Returns null when the window no longer exists. */
  getWindowState(windowId: number): Promise<string | null>;
  setBadge(state: MonitoringState): Promise<void>;
  setTickAlarm(enabled: boolean): Promise<void>;
}

export interface MonitorDeps {
  store: KeyValueStore;
  browser: BrowserApi;
  transport: EventTransport;
  api: SessionApi;
  now: () => Date;
  uuid: () => string;
  random: () => number;
  version: string;
}

export interface StartInput {
  contest_id: string;
  candidate_id: string;
  access_code: string;
  acknowledged: boolean;
}

const START_ERRORS: Record<number, string> = {
  0: "Cannot reach the exam server. Check the network and try again.",
  400: "Check the contest ID, candidate ID, and access code.",
  401: "The contest ID, candidate ID, or access code is incorrect.",
  403: "This contest is not open.",
  429: "The server is busy. Wait a moment and try again.",
};

export type StartResult = { ok: true } | { ok: false; error: string };

/**
 * How a signal was obtained, stored on every event so reviewers can tell a
 * direct Chrome notification from a window-state observation.
 */
type WindowStateDetection = "window_state_event" | "window_state_poll";

const SESSION_KEY = "session";
const TOKENS_KEY = "tokens";
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export class Monitor {
  private readonly queue: EventQueue;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MonitorDeps) {
    this.queue = new EventQueue(
      deps.store,
      deps.transport,
      () => deps.now().getTime(),
      deps.random,
    );
  }

  startSession(input: StartInput): Promise<StartResult> {
    const at = this.timestamp();
    return this.run(async () => {
      if (await this.loadSession()) {
        return { ok: false, error: "A session is already active." };
      }
      if (!input.acknowledged) {
        return {
          ok: false,
          error: "Please acknowledge the monitoring notice first.",
        };
      }
      const contestId = input.contest_id.trim();
      const candidateId = input.candidate_id.trim();
      if (!ID_PATTERN.test(contestId) || !ID_PATTERN.test(candidateId)) {
        return {
          ok: false,
          error:
            "IDs must be 1-64 characters: letters, numbers, dot, dash, or underscore.",
        };
      }
      const tab = await this.deps.browser.getActiveTab();
      if (!tab) {
        return { ok: false, error: "Could not identify the exam tab." };
      }

      let issued;
      try {
        issued = await this.deps.api.startSession({
          contest_id: contestId,
          candidate_id: candidateId,
          access_code: input.access_code,
        });
      } catch (error) {
        const status = error instanceof ApiError ? error.status : -1;
        return {
          ok: false,
          error: START_ERRORS[status] ?? "The session could not be started.",
        };
      }
      await this.storeToken(issued.session_id, issued.token, issued.expires_at);

      const windowState = await this.deps.browser.getWindowState(tab.windowId);
      const session: Session = {
        session_id: issued.session_id,
        offline_since: null,
        auth_expired: false,
        contest_id: contestId,
        candidate_id: candidateId,
        started_at: at,
        exam_tab_id: tab.tabId,
        exam_window_id: tab.windowId,
        focus: "exam",
        window_state: windowState,
      };
      await this.saveSession(session);
      await this.record(session, "SESSION_STARTED", at, {
        candidate_id: candidateId,
        exam_tab_id: tab.tabId,
        exam_window_id: tab.windowId,
        window_state: windowState,
        browser_fullscreen: windowState === "fullscreen",
        extension_version: this.deps.version,
      });
      await this.sync(session);
      return { ok: true };
    });
  }

  endSession(): Promise<StartResult> {
    const at = this.timestamp();
    return this.run(async () => {
      const session = await this.loadSession();
      if (!session) {
        return { ok: false, error: "No session is active." };
      }
      await this.record(session, "SESSION_ENDED", at, {
        reason: "candidate_ended",
      });
      await this.queue.flush();
      const token = await this.tokenFor(session.session_id);
      if (token) {
        // Best effort: the queued SESSION_ENDED also closes it on the server.
        await this.deps.api.endSession(token).catch(() => undefined);
      }
      await this.deps.store.remove(SESSION_KEY);
      await this.sync(null);
      return { ok: true };
    });
  }

  requestPairingCode(): Promise<StartResult & { pairing_code?: string }> {
    return this.run(async () => {
      const session = await this.loadSession();
      const token = session && (await this.tokenFor(session.session_id));
      if (!token) {
        return { ok: false, error: "No session is active." };
      }
      try {
        const { pairing_code } = await this.deps.api.createPairingCode(token);
        return { ok: true, pairing_code };
      } catch {
        return {
          ok: false,
          error: "Could not get a pairing code from the exam server.",
        };
      }
    });
  }

  handleTabActivated(tabId: number, windowId: number): Promise<void> {
    const at = this.timestamp();
    return this.withSession(async (session) => {
      await this.record(session, "TAB_ACTIVATED", at, {
        tab_id: tabId,
        window_id: windowId,
        is_exam_tab: tabId === session.exam_tab_id,
        exam_tab_open: session.exam_tab_id !== null,
        detection: "chrome_event",
      });
    });
  }

  handleTabCreated(
    tabId: number,
    windowId: number,
    openerTabId: number | undefined,
  ): Promise<void> {
    const at = this.timestamp();
    return this.withSession(async (session) => {
      await this.record(session, "TAB_CREATED", at, {
        tab_id: tabId,
        window_id: windowId,
        opened_from_exam_tab:
          openerTabId !== undefined && openerTabId === session.exam_tab_id,
        detection: "chrome_event",
      });
    });
  }

  handleTabRemoved(tabId: number): Promise<void> {
    return this.withSession(async (session) => {
      if (tabId !== session.exam_tab_id) {
        return;
      }
      session.exam_tab_id = null;
      session.exam_window_id = null;
      session.window_state = null;
      await this.saveSession(session);
    });
  }

  handleTabAttached(tabId: number, newWindowId: number): Promise<void> {
    const at = this.timestamp();
    return this.withSession(async (session) => {
      if (tabId !== session.exam_tab_id) {
        return;
      }
      session.exam_window_id = newWindowId;
      await this.saveSession(session);
      await this.checkWindowState(session, at, "window_state_event");
    });
  }

  /**
   * Reports once per excursion: one LOST when focus leaves the exam window and
   * one RETURNED when it comes back, however many places it visits between.
   */
  handleFocusChanged(windowId: number): Promise<void> {
    const at = this.timestamp();
    return this.withSession(async (session) => {
      const previous = session.focus;
      const target = this.focusTarget(session, windowId);
      session.focus = target;
      await this.saveSession(session);

      if (previous === "exam" && target !== "exam") {
        await this.record(session, "BROWSER_FOCUS_LOST", at, {
          focus_target: target,
          detection: "chrome_event",
        });
      } else if (previous !== "exam" && target === "exam") {
        await this.record(session, "BROWSER_FOCUS_RETURNED", at, {
          previous_focus: previous,
          detection: "chrome_event",
        });
      }
      await this.checkWindowState(session, at, "window_state_event");
    });
  }

  handleWindowBoundsChanged(windowId: number): Promise<void> {
    const at = this.timestamp();
    return this.withSession(async (session) => {
      if (windowId === session.exam_window_id) {
        await this.checkWindowState(session, at, "window_state_event");
      }
    });
  }

  /** Periodic fallback in case a window-state change produced no event. */
  handleTick(): Promise<void> {
    const at = this.timestamp();
    return this.run(async () => {
      const session = await this.loadSession();
      if (session) {
        await this.checkWindowState(session, at, "window_state_poll");
        await this.heartbeat(session, at);
      }
      await this.sync(await this.loadSession());
    });
  }

  private async heartbeat(session: Session, at: string): Promise<void> {
    const token = await this.tokenFor(session.session_id);
    if (!token) {
      return;
    }
    try {
      const { session_active } = await this.deps.api.heartbeat(token);
      if (session.offline_since) {
        await this.record(session, "NETWORK_RECONNECTED", at, {
          offline_since: session.offline_since,
        });
        session.offline_since = null;
        await this.queue.resetBackoff();
      }
      session.auth_expired = false;
      await this.saveSession(session);
      if (!session_active) {
        // Closed on the server, for example by a newer session.
        await this.deps.store.remove(SESSION_KEY);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        session.auth_expired = true;
      } else {
        session.offline_since ??= at;
      }
      await this.saveSession(session);
    }
  }

  private async tokenFor(sessionId: string): Promise<string | undefined> {
    const tokens = (await this.deps.store.get<StoredTokens>(TOKENS_KEY)) ?? {};
    return tokens[sessionId]?.token;
  }

  private async storeToken(
    sessionId: string,
    token: string,
    expiresAt: string,
  ): Promise<void> {
    const tokens = (await this.deps.store.get<StoredTokens>(TOKENS_KEY)) ?? {};
    tokens[sessionId] = { token, expires_at: expiresAt };
    await this.deps.store.set(TOKENS_KEY, tokens);
  }

  /** A token is only needed while its session or undelivered events remain. */
  private async pruneTokens(
    session: Session | null | undefined,
    queued: ExamEvent[],
  ): Promise<void> {
    const tokens = (await this.deps.store.get<StoredTokens>(TOKENS_KEY)) ?? {};
    const needed = new Set(queued.map((event) => event.session_id));
    if (session) {
      needed.add(session.session_id);
    }
    const kept = Object.entries(tokens).filter(([id]) => needed.has(id));
    if (kept.length !== Object.keys(tokens).length) {
      await this.deps.store.set(TOKENS_KEY, Object.fromEntries(kept));
    }
  }

  /** Tab and window IDs do not survive a browser restart. */
  handleBrowserStartup(): Promise<void> {
    return this.run(async () => {
      const session = await this.loadSession();
      if (session) {
        session.exam_tab_id = null;
        session.exam_window_id = null;
        session.window_state = null;
        await this.saveSession(session);
      }
      await this.sync(session);
    });
  }

  /** Restores the alarm and badge, which may not survive an update. */
  restore(): Promise<void> {
    return this.run(async () => {
      await this.sync(await this.loadSession());
    });
  }

  getStatus(): Promise<StatusView> {
    return this.run(async () => {
      const session = await this.loadSession();
      const queue = await this.queue.read();
      return {
        monitoring: monitoringState(session),
        session: session
          ? {
              session_id: session.session_id,
              contest_id: session.contest_id,
              candidate_id: session.candidate_id,
              started_at: session.started_at,
            }
          : null,
        focus: session?.focus ?? null,
        browser_fullscreen:
          session?.window_state == null
            ? null
            : session.window_state === "fullscreen",
        queued: queue.events.length,
        dropped: queue.dropped,
        connection: session?.auth_expired
          ? "auth_expired"
          : session?.offline_since
            ? "offline"
            : "online",
        upload_error: queue.last_error,
        recent: queue.events
          .slice(-RECENT_EVENT_COUNT)
          .reverse()
          .map(({ event_id, type, occurred_at }) => ({
            event_id,
            type,
            occurred_at,
          })),
      };
    });
  }

  private focusTarget(session: Session, windowId: number): FocusTarget {
    if (windowId === WINDOW_ID_NONE) {
      return "outside_chrome";
    }
    return windowId === session.exam_window_id ? "exam" : "other_chrome_window";
  }

  /**
   * Browser-level fullscreen only: this reads the window's state and says
   * nothing about the page's own DOM fullscreen.
   */
  private async checkWindowState(
    session: Session,
    at: string,
    detection: WindowStateDetection,
  ): Promise<void> {
    if (session.exam_window_id === null) {
      return;
    }
    const state = await this.deps.browser.getWindowState(
      session.exam_window_id,
    );
    if (state === null || state === session.window_state) {
      return;
    }
    const wasFullscreen = session.window_state === "fullscreen";
    const isFullscreen = state === "fullscreen";
    session.window_state = state;
    await this.saveSession(session);

    if (wasFullscreen !== isFullscreen) {
      await this.record(
        session,
        isFullscreen ? "FULLSCREEN_ENTERED" : "FULLSCREEN_EXITED",
        at,
        { window_state: state, scope: "browser_window", detection },
      );
    }
  }

  private withSession(task: (session: Session) => Promise<void>) {
    return this.run(async () => {
      const session = await this.loadSession();
      if (!session) {
        return;
      }
      await task(session);
      await this.sync(session);
    });
  }

  /** Chrome delivers events concurrently; storage updates must not interleave. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private timestamp(): string {
    return this.deps.now().toISOString();
  }

  private loadSession(): Promise<Session | undefined> {
    return this.deps.store.get<Session>(SESSION_KEY);
  }

  private saveSession(session: Session): Promise<void> {
    return this.deps.store.set(SESSION_KEY, session);
  }

  private record(
    session: Session,
    type: ExamEventType,
    occurredAt: string,
    metadata: EventMetadata,
  ): Promise<void> {
    const event: ExamEvent = {
      event_id: this.deps.uuid(),
      contest_id: session.contest_id,
      session_id: session.session_id,
      type,
      occurred_at: occurredAt,
      source: "extension",
      metadata,
    };
    return this.queue.add(event);
  }

  private async sync(session: Session | null | undefined): Promise<void> {
    await this.queue.flush();
    const queue = await this.queue.read();
    await this.deps.browser.setBadge(monitoringState(session));
    await this.pruneTokens(session, queue.events);
    await this.deps.browser.setTickAlarm(
      Boolean(session) || queue.events.length > 0,
    );
  }
}

function monitoringState(session: Session | null | undefined): MonitoringState {
  if (!session) {
    return "idle";
  }
  return session.exam_tab_id === null || session.auth_expired
    ? "attention"
    : "active";
}
