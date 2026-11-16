# Test plan

Run `npm run check` before calling any phase complete. Set `REQUIRE_DOTNET=1` where the agent must be covered.

## Layers

| Layer       | Tool                                   | Scope                                            |
| ----------- | -------------------------------------- | ------------------------------------------------ |
| Static      | Prettier, ESLint, `tsc`, C# compiler   | All code                                         |
| Unit        | Vitest, xUnit                          | Contract, event mapping, flag rules, queue logic |
| Integration | Vitest against a disposable PostgreSQL | API, constraints, access control                 |
| Manual      | Real Chrome and Windows                | Behaviour that automated tests cannot exercise   |
| Load        | Tool selected in Phase 6               | 400 simulated sessions with event bursts         |

## Phase 0 (current)

| Check                                       | Command                          |
| ------------------------------------------- | -------------------------------- |
| Clean install from the lockfile             | `npm ci`                         |
| Format, lint, types, tests, and builds      | `npm run check`                  |
| Agent builds and tests                      | `REQUIRE_DOTNET=1 npm run check` |
| `.env` is ignored and `.env.example` is not | `git check-ignore`               |

## End-to-end check

Run for a release candidate against a real PostgreSQL server: session start, duplicate retries, agent pairing with the real Win32 reader, heartbeat timeout, dashboard summary, CSV export, and purge. The manual procedures are `extension-manual-test.md` and `agent-manual-test.md`.

## Later phases

| Phase | Must demonstrate                                                                                                                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Tab activation, new tab, focus loss, and browser fullscreen each produce a timestamped event with a unique ID; events persist across service worker restarts; the not-monitoring state is visible; see `extension-manual-test.md` |
| 2     | A repeated `event_id` stores one row; invalid or expired tokens are rejected; a candidate cannot read another's events; invalid payloads, oversized requests, and rate limits are rejected correctly                              |
| 3     | Chrome to Notepad and back each produce an event; a stopped agent appears disconnected after the timeout; process lookup failure and network loss are handled; no administrator rights are needed                                 |
| 4     | A submitted event appears within the refresh interval; timelines are ordered; CSV matches the timeline; admin routes enforce authentication and role; labels never claim proof of cheating                                        |
| 5     | A pilot machine runs every component; IT confirms the policies applied; a practice contest can be completed and submitted                                                                                                         |
| 6     | 5, 10, then 25–30 real machines; 400 simulated sessions; Wi-Fi loss, API downtime, client restarts, and duplicate retries; measured delivery delay, duplicate rate, error rate, database usage, and dashboard refresh delay       |

## False-positive checks

Phases 1, 3, and 4 must cover legitimate activity, such as a Chrome permission prompt, a Windows notification taking focus, or a monitor change. One such event must never be presented as more than `Needs review`.
