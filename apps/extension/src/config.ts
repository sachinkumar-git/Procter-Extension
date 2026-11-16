/** Value of chrome.windows.WINDOW_ID_NONE, kept here so logic stays testable. */
export const WINDOW_ID_NONE = -1;

export const TICK_ALARM = "exam-guard-tick";
/** Chrome's minimum alarm period. */
export const TICK_PERIOD_MINUTES = 0.5;

export const MAX_QUEUED_EVENTS = 5000;
export const UPLOAD_BATCH_SIZE = 100;
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 300_000;
export const RECENT_EVENT_COUNT = 8;
