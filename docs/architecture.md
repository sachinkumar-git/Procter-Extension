# Architecture

The root `README.md` is the source of truth for requirements. This document records how they are being built.

## Components

| Component              | Path                 | Responsibility                                                  |
| ---------------------- | -------------------- | --------------------------------------------------------------- |
| Chrome extension (MV3) | `apps/extension`     | Browser events and extension heartbeat                          |
| Windows agent (.NET)   | `apps/windows-agent` | Foreground application changes and agent heartbeat              |
| API (Express)          | `apps/api`           | Authentication, validation, deduplication, disconnect detection |
| Database (PostgreSQL)  | not yet created      | Contests, candidates, sessions, events, admin users             |
| Admin dashboard        | `apps/admin`         | Summary, timelines, review flags, CSV export                    |
| Shared contract        | `packages/shared`    | Event names and API types                                       |

Platform boundaries are strict: Chrome APIs stay in the extension and Win32 APIs stay in the agent. Lockdown (DevTools, kiosk mode) is applied by IT through managed policy. The software records signals for human review; it does not prevent cheating, and it never disqualifies anyone.

## ADR-001: Monorepo and stack

**Status:** Accepted for Phase 0.

| Decision                      | Choice                                     | Reason                                                                             |
| ----------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Package manager               | npm workspaces                             | Already installed with Node; pnpm and yarn are not, and nothing here requires them |
| Runtime                       | Node 22                                    | Installed version; supported by Vite 8 and Vitest 5                                |
| TypeScript                    | 6.0.x                                      | TypeScript 7 is published, but typescript-eslint 8 requires `<6.1.0`               |
| Lint and format               | ESLint 10, typescript-eslint 8, Prettier 3 | Standard, free tooling                                                             |
| Tests                         | Vitest 5; xUnit v3 for the agent           | Vitest reuses the Vite toolchain                                                   |
| Extension and dashboard build | Vite 8                                     | One bundler for both, so no extra extension build tool                             |
| Dashboard                     | React 19                                   | Specified by the README                                                            |
| Windows agent                 | .NET 10 (`net10.0-windows`)                | Current LTS; .NET 11 is still a release candidate and is a short-support release   |

Dependencies are added in the phase that first needs them. Express, Zod (or an equivalent validator), and a PostgreSQL client are expected in Phase 2, and their versions will be selected and verified then.

The `exam-guard/` folder in the README's suggested layout is treated as this repository's root.

## ADR-002: Browser monitoring without page scripts

**Status:** Approved by the project owner for Phase 1. Where it differs from README Phase 1 tasks 3 (`visibilitychange`, `fullscreenchange`), this decision takes precedence.

The extension injects nothing into exam pages. It has no content scripts or host permissions, and requests only `storage` and `alarms`. Without the `tabs` permission Chrome does not give it URLs or titles. The exam tab is the tab active when the session starts.

| Signal              | Source                                                                           | `detection` metadata                        | What it does not show                                                      |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Tab switch          | `chrome.tabs.onActivated`                                                        | `chrome_event`                              | What the tab contained                                                     |
| New tab             | `chrome.tabs.onCreated`                                                          | `chrome_event`                              | What was opened                                                            |
| Focus lost/returned | `chrome.windows.onFocusChanged`                                                  | `chrome_event`                              | Which application took focus (Phase 3 agent)                               |
| Browser fullscreen  | `chrome.windows.get()`, prompted by bounds and focus events or a 30-second alarm | `window_state_event` or `window_state_poll` | The page's DOM fullscreen. Polled times can be up to about 30 seconds late |

`EXAM_TAB_HIDDEN` and `EXAM_TAB_VISIBLE` stay in the shared contract but the extension does not emit them. Page visibility is not observable without a page script, and the extension does not approximate it under those names.

## ADR-003: Independent event delivery

**Status:** Approved by the project owner.

The extension and the Windows agent each send events to the API over HTTPS, identified by `source`, and neither relays for the other. The API merges both into one timeline. Each client uses client-generated event IDs, a local retry queue, and short-lived session-scoped credentials; permanent secrets are never embedded. The API adds a server-side received timestamp and ingests idempotently.

Both clients call the API directly. Neither depends on the other being installed or running.

## ADR-004: Backend and identity

**Status:** Accepted for Phases 2 to 5.

- **Dependencies:** Express 5, Zod 4, `pg`, helmet, cors, and express-rate-limit. PGlite is used for tests only.
- **Database:** plain PostgreSQL, so it can run on a college server or a hosted service. Row-level security is enabled with no policies, so hosted roles such as Supabase's `anon` cannot read tables.
- **Candidate sign-in:** the organiser's CLI issues a one-per-candidate access code, stored only as a hash.
- **Tokens:** random, opaque, stored as SHA-256 hashes, scoped to one session and one client type, and short-lived. They can be invalidated in the database, and need no signing secret.
- **Agent pairing:** the extension requests a single-use code valid for 10 minutes, and the candidate enters it in the agent.
- **Heartbeats:** update connection status on the session and are not stored as events, which avoids hundreds of thousands of low-value rows per contest. Agent start and stop are stored as `AGENT_HEARTBEAT` events with `lifecycle` metadata.
- **Foreground detection:** polls `GetForegroundWindow` every 250 ms. The return to the browser is `FOREGROUND_APP_CHANGED` with `is_approved_browser: true`.
- **Review:** per-event severity is set by the server, and session levels come from the configurable rules in `.env`. An outage is reported separately as `Monitoring unavailable`.
- **Organiser setup:** done by CLI. The dashboard is for review only.

## Design commitments for later phases

- **Idempotency:** `event_id` is unique in the database, and ingestion uses insert-on-conflict-do-nothing.
- **Time:** `occurred_at` comes from the client, so the server should also store its own `received_at` to expose clock skew. All timestamps are UTC; the dashboard displays local time.
- **Disconnects:** `AGENT_DISCONNECTED` and `EXTENSION_DISCONNECTED` are generated by the server (`source: "server"`) when a heartbeat exceeds the grace period, because a dead client cannot report itself.
- **Service worker lifetime:** MV3 service workers are suspended when idle, so state and the event queue must be persisted in `chrome.storage`, and heartbeats scheduled with `chrome.alarms` rather than timers.
- **Dashboard updates:** polling or one server-managed stream; no per-candidate database Realtime connections.

## Open questions

These need a decision before the phase listed. Questions 1 and 2 are resolved by ADR-002 and ADR-003; questions 3, 4, and 6 by ADR-004. Question 5 is open only for the choice of host.

| #   | Phase | Question                                                                                                                                                                                                     | Recommendation                                                                                                                                                                                     |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 1     | **README conflict.** `visibilitychange` and `fullscreenchange` on the exam page can only be observed from a content script running in that page, but the README prohibits injecting scripts into HackerRank. | Without written approval, use no content script on HackerRank: derive fullscreen from `chrome.windows` state, and hidden/visible from tab activation and window focus. Confirm with the organiser. |
| 2   | 1     | The README diagram draws the extension's traffic passing through the agent.                                                                                                                                  | Each client sends directly to the API, so that one failing does not silence the other.                                                                                                             |
| 3   | 3     | How does the agent obtain a session token tied to the same candidate as the extension?                                                                                                                       | Short-lived pairing code issued by the API, or Chrome native messaging. Decide in Phase 3.                                                                                                         |
| 4   | 3     | Phase 3 requires agent start/stop reporting and a return event, but the event contract has no dedicated types for them.                                                                                      | Carry them in `FOREGROUND_APP_CHANGED` metadata, or extend the contract with approval.                                                                                                             |
| 5   | 2     | Database host: Supabase free tier or a college-run PostgreSQL server. Current limits must be verified against the 400-session workload.                                                                      | Develop against plain PostgreSQL so either remains possible.                                                                                                                                       |
| 6   | 4     | Section 6 of the README defines a fourth label, "Monitoring unavailable", which Phase 4 does not list.                                                                                                       | Display it as a separate status, since an outage is not a misconduct signal.                                                                                                                       |
| 7   | 5     | HackerRank written permission and terms review are outstanding.                                                                                                                                              | Organiser to obtain this before any live use.                                                                                                                                                      |
