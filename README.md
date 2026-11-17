# CodeWallah Exam Guard

> A lightweight, lab-focused exam integrity monitoring system for coding contests. It records reviewable activity signals; it does **not** guarantee that cheating is impossible.

**Project status:** Planning / MVP  
**Initial platform:** Windows lab computers + Google Chrome  
**Initial contest platform:** HackerRank, subject to written permission/terms review before integration or deployment  
**Setup:** see [docs/development.md](docs/development.md)

---

## 1. Goal

Build a zero-software-licence-cost MVP that helps college invigilators review suspicious activity during a coding contest with approximately 400 participants.

The first version will:

- Detect Chrome tab changes, new tabs, browser focus loss, and fullscreen exits.
- On Windows lab computers, detect when a different application becomes the foreground application.
- Record monitoring-agent disconnects and missing heartbeats.
- Show candidate activity and timestamps in a CodeWallah-branded admin dashboard.
- Export session activity as CSV for manual review.

**Important:** The system produces signals, not proof of cheating. Do not automatically disqualify a candidate from one event. An invigilator must review the timeline and context.

## 2. What this project will and will not do

| Capability | MVP behaviour | Limitation |
|---|---|---|
| Switch to another Chrome tab | Detect and log | Does not prevent switching by itself |
| Open a new Chrome tab | Detect and log | Does not reliably identify what the user viewed |
| Leave the Chrome window / switch app | Extension logs focus loss; Windows agent identifies the foreground app | Does not see every background activity |
| Exit fullscreen | Detect and log | A normal extension cannot force the user to remain fullscreen |
| Open F12 / Developer Tools | Do not claim extension-level blocking or reliable detection | College IT must apply managed Chrome policy if DevTools must be disabled |
| Open external desktop application | Windows agent logs foreground application changes | Does not prove intent; does not reliably detect every background process |
| Stop/kill the monitoring agent | Detect missing heartbeat / agent disconnect | A disconnect may also be caused by a crash or network issue |
| Use a phone or another computer | Not reliably detectable in MVP | Outside the visibility of a desktop extension/agent |
| Webcam phone/face detection | Not included in MVP | Optional future experiment only, with explicit consent; cannot guarantee detection |

## 3. Proposed architecture

```text
                    Candidate Windows Lab PC
  +---------------------------------------------------------+
  |                                                         |
  |  Google Chrome                                         |
  |  +---------------------------+                          |
  |  | CodeWallah Chrome         |                          |
  |  | Extension (Manifest V3)   |                          |
  |  | - tab events              |                          |
  |  | - window focus            |                          |
  |  | - fullscreen state        |                          |
  |  | - extension heartbeat     |                          |
  |  +-------------+-------------+                          |
  |                |                                        |
  |                | HTTPS event batches                    |
  |                v                                        |
  |  +---------------------------+                          |
  |  | Windows Monitoring Agent  |                          |
  |  | - foreground app changes  |                          |
  |  | - process metadata        |                          |
  |  | - agent heartbeat         |                          |
  |  +-------------+-------------+                          |
  +----------------|----------------------------------------+
                   |
                   v
        +---------------------------+
        | Node.js / Express API     |
        | - authenticate session   |
        | - validate events        |
        | - rate limit             |
        | - deduplicate event IDs  |
        +-------------+-------------+
                      |
                      v
        +---------------------------+
        | PostgreSQL / Supabase    |
        | - candidates             |
        | - sessions               |
        | - events                 |
        +-------------+-------------+
                      |
                      v
        +---------------------------+
        | React Admin Dashboard    |
        | - live session overview  |
        | - candidate timeline     |
        | - review flags            |
        | - CSV export              |
        +---------------------------+
```

### Technology choices

- **Browser extension:** TypeScript, Chrome Extension Manifest V3.
- **Windows agent:** C# / .NET Windows desktop process. Use Win32 foreground-window APIs (`GetForegroundWindow` and `GetWindowThreadProcessId`) to identify the active window and its process.
- **Backend:** Node.js, Express, TypeScript.
- **Database:** PostgreSQL. Supabase may be used for the initial prototype if its current plan limits and project availability suit the pilot.
- **Admin dashboard:** React, TypeScript, Vite.
- **Repository:** One monorepo with separate apps/packages.

Do not add Electron unless a specific desktop UI requirement justifies it. A small Windows agent is sufficient for foreground-application telemetry.

## 4. Development phases

Build one phase at a time. Do not start the next phase until the current phase builds, its tests pass, and its acceptance criteria are demonstrated.

### Phase 0 — Repository inspection and project setup

**Tasks**

1. Inspect the existing repository before changing files.
2. Confirm the package manager and existing conventions.
3. Create a monorepo structure without deleting unrelated user work.
4. Add formatting, linting, environment-variable examples, and a root README.
5. Add a short architecture decision record describing the chosen stack.

**Suggested structure**

```text
exam-guard/
├── apps/
│   ├── extension/          # Chrome Manifest V3 extension
│   ├── windows-agent/      # C# Windows foreground app monitor
│   ├── api/                # Node.js / Express API
│   └── admin/              # React admin dashboard
├── packages/
│   └── shared/             # Shared event names and API types
├── docs/
│   ├── architecture.md
│   ├── privacy-and-consent.md
│   ├── lab-deployment.md
│   └── test-plan.md
├── .env.example
└── README.md
```

**Acceptance criteria**

- All apps have a documented local development command.
- No secrets are committed.
- A clean install and root build/test commands work.

### Phase 1 — Chrome extension MVP

**Tasks**

1. Create a Manifest V3 extension in TypeScript.
2. Add a branded popup showing monitoring status, candidate/session ID, and clear exam instructions.
3. Detect and record:
   - `chrome.tabs.onActivated` — active tab changed.
   - `chrome.tabs.onCreated` — tab created.
   - `chrome.windows.onFocusChanged` — Chrome window focus changed/lost.
   - `visibilitychange` — exam tab became hidden/visible.
   - `fullscreenchange` — fullscreen entered/exited on the exam page.
4. Keep the monitoring state in the extension service worker using supported MV3 patterns.
5. Queue events locally while the network is unavailable and retry later.
6. Do not collect page text, passwords, code submissions, or browsing history beyond the event metadata required for the contest.

**Acceptance criteria**

- Events are timestamped and contain a unique `event_id`.
- Normal activity is not incorrectly labelled as a confirmed violation.
- The extension clearly shows when it is disconnected or not monitoring.
- Tests cover tab activation, new tab, focus loss, visibility, and fullscreen events.

### Phase 2 — Backend and event ingestion

**Tasks**

1. Build an Express API with TypeScript.
2. Create endpoints for candidate session start, event batch ingestion, heartbeat, session end, and admin reporting.
3. Validate all payloads server-side.
4. Use unique event IDs for idempotency so retries do not create duplicate events.
5. Authenticate candidate sessions with short-lived, scoped tokens.
6. Keep database service credentials on the server only.
7. Add rate limiting, request-size limits, structured logs, and health checks.
8. Store event timestamps in UTC; show local time in the dashboard.

**Initial data model**

- `contests`: contest ID, name, start/end time, status.
- `candidates`: candidate ID, contest ID, display name or pseudonymous identifier.
- `sessions`: session ID, candidate ID, started/ended time, extension status, agent status.
- `events`: event ID, session ID, event type, timestamp, source, severity, metadata JSON.
- `admin_users`: administrator identity and role.

Use database constraints and indexes for `event_id`, `session_id`, and event timestamp.

**Acceptance criteria**

- Repeated submission of the same `event_id` creates one stored event.
- Invalid session tokens are rejected.
- A candidate cannot read another candidate's events.
- The API can accept batched events and recover from client retries.

### Phase 3 — Windows monitoring agent

**Tasks**

1. Build a small Windows user-session application in C#/.NET.
2. Detect foreground-window changes using Win32 APIs.
3. Resolve the foreground window to process name and process ID when permitted.
4. Send an event when the foreground app changes away from the approved browser.
5. Send a periodic heartbeat and report agent start/stop state.
6. Add a visible tray/status indicator and a clear notice that monitoring is active.
7. Handle missing permissions, process lookup failures, crashes, and network loss gracefully.
8. Never terminate applications or attempt hidden surveillance.

**Important implementation note**

A foreground-window monitor detects which application is active. It does not prove that every other application is closed, and it may not detect applications running only in the background. Do not label every process found on the machine as cheating.

**Acceptance criteria**

- Switching from Chrome to Notepad or another test application produces a timestamped foreground-app event.
- Returning to Chrome produces a corresponding return event.
- Agent disconnection becomes visible after a configurable heartbeat timeout.
- The agent does not require administrator privileges unless a documented deployment requirement demands them.

### Phase 4 — Admin dashboard

**Tasks**

1. Build a CodeWallah-branded React dashboard.
2. Show contest summary: registered candidates, active sessions, disconnected agents, and sessions requiring review.
3. Show each candidate's chronological activity timeline.
4. Filter by event type, candidate, and time range.
5. Provide CSV export.
6. Use clear labels: `Information`, `Needs review`, and `High review priority` rather than claiming that an event proves cheating.
7. Use polling or a server-managed stream for the initial pilot. Do not create one database Realtime/WebSocket connection per candidate without verifying plan limits and load capacity.

**Acceptance criteria**

- An event submitted by a candidate appears in the dashboard within the configured refresh interval.
- Candidate timelines are correctly ordered and export correctly.
- Admin routes require authentication and role checks.

### Phase 5 — Lab lockdown and deployment

**Tasks**

1. Coordinate with the college IT administrator before configuring lab machines.
2. Check Windows edition and device-management capabilities.
3. Ask IT to evaluate Windows Assigned Access / kiosk configuration for the lab's approved applications.
4. If Developer Tools must be disabled, ask IT to apply the appropriate managed Chrome `DeveloperToolsAvailability` policy.
5. Deploy the extension through an administrator-approved managed Chrome installation method. Do not assume a website download alone can silently install a Chrome extension.
6. Install the Windows agent using an administrator-approved process.
7. Provide candidates with a clear notice, consent/acknowledgement, support instructions, and a pre-exam system check.
8. Test HackerRank login, editor loading, code execution, and submission in a normal supported browser.

**HackerRank restriction**

Do not embed HackerRank in an Electron/WebView, inject scripts into HackerRank, modify its page, or claim an authorised integration unless HackerRank has explicitly approved the approach. Review the current HackerRank terms and obtain written permission where required before using the system with a live HackerRank contest. Keep Exam Guard platform-independent.

**Acceptance criteria**

- A pilot machine can install and start all approved components.
- HackerRank's required workflow works in the supported browser.
- IT confirms the actual kiosk and Chrome policies applied on each lab image.
- A candidate can complete a full practice contest and submit successfully.

### Phase 6 — Load test and pilot

**Tasks**

1. Test with 5 machines, then 10, then 25–30 participants.
2. Simulate 400 candidate sessions and realistic event bursts against the backend.
3. Test Wi-Fi loss, API downtime, extension restart, agent restart, duplicate retries, and candidate logout.
4. Measure event delivery delay, duplicate rate, API errors, database usage, and dashboard refresh delay.
5. Run a supervised mock contest before the real event.
6. Keep human invigilators in the lab; the software is an additional review tool.

**Acceptance criteria**

- No lost events in the tested retry/reconnect scenarios, within documented storage limits.
- Duplicate event retries do not create duplicate rows.
- The backend passes the agreed 400-session load test.
- The contest organiser has a manual fallback if monitoring or internet fails.

### Phase 7 — Optional future enhancements

Only consider after the core system is stable:

- Optional webcam-based visible-phone/face-presence experiments, processed locally where possible and enabled only with explicit informed consent.
- Device inventory and pre-exam health checks.
- Institution-specific tenants and roles.
- Self-hosted university deployment.
- Signed installers and controlled update mechanism.
- Additional browser/platform support.

Webcam analysis cannot reliably detect a phone outside the camera frame, a second device, or all forms of external assistance. Never market it as complete cheating prevention.

## 5. Event contract

Use a shared event type definition across the extension, Windows agent, API, and dashboard.

```ts
type ExamEventType =
  | "SESSION_STARTED"
  | "SESSION_ENDED"
  | "TAB_ACTIVATED"
  | "TAB_CREATED"
  | "EXAM_TAB_HIDDEN"
  | "EXAM_TAB_VISIBLE"
  | "BROWSER_FOCUS_LOST"
  | "BROWSER_FOCUS_RETURNED"
  | "FULLSCREEN_EXITED"
  | "FULLSCREEN_ENTERED"
  | "FOREGROUND_APP_CHANGED"
  | "AGENT_HEARTBEAT"
  | "AGENT_DISCONNECTED"
  | "EXTENSION_HEARTBEAT"
  | "EXTENSION_DISCONNECTED"
  | "NETWORK_RECONNECTED";

interface ExamEvent {
  event_id: string;       // UUID generated by the client
  contest_id: string;
  session_id: string;
  type: ExamEventType;
  occurred_at: string;    // ISO-8601 UTC timestamp
  source: "extension" | "windows-agent" | "server";
  metadata?: Record<string, string | number | boolean | null>;
}
```

Do not put passwords, authentication tokens, full browser history, source code, or unnecessary personal information in `metadata`.

## 6. Review flagging rules

Start with transparent rules, not AI scoring.

- **Information:** session start/end, normal return to exam, heartbeat received.
- **Needs review:** one tab switch, one focus loss, or one fullscreen exit.
- **High review priority:** repeated focus changes, repeated fullscreen exits, or multiple external foreground-app changes within a short period.
- **Monitoring unavailable:** extension or agent heartbeat missing beyond the configured grace period.

Thresholds must be configurable by the organiser and shown in the report. A monitoring outage is not proof of misconduct. An invigilator makes the final decision using the full timeline and context.

## 7. Privacy and security requirements

- Show candidates what the extension and agent monitor before the exam begins.
- Collect only event metadata needed for exam integrity.
- Do not collect keystrokes, clipboard contents, passwords, screen recordings, or browsing page content.
- Do not enable webcam or microphone in the MVP.
- Define a retention period with the college; delete or anonymise data after that period.
- Use HTTPS for network communication.
- Store secrets only in server environment variables.
- Apply least-privilege access and row-level database restrictions where applicable.
- Restrict dashboard access to authorised contest administrators.
- Log administrative access and exports.
- Provide a contact and a process for reporting false flags or technical issues.

## 8. Zero-cost expectations

The source code and initial software stack can use free/open-source tools. A pilot may also use free service tiers, subject to their current quotas and terms. **Do not promise unlimited free hosting or guaranteed 400-user capacity.**

Before the event, verify:

- Current database, API hosting, bandwidth, storage, and connection limits.
- Whether a free hosting tier permits the intended use.
- The college's ability to provide a lab server or approved hosting.
- Whether a Chrome Web Store account or paid code-signing certificate is required for the chosen distribution route.

For a controlled lab, an institution-approved local server may avoid cloud hosting charges, but it still needs a reliable machine, network, backups, and IT support.

## 9. Instructions for Claude Code

Follow these rules while implementing the project:

1. **Inspect before editing.** Review the existing repository, scripts, dependencies, and coding style first.
2. **Work phase by phase.** Implement only the current phase. Do not generate the entire product in one pass.
3. **Plan before coding.** For each phase, list files to create/change, risks, and verification commands.
4. **Keep the build runnable.** After each meaningful change, run type checks, lint, tests, and build for the affected app.
5. **Do not invent capabilities.** Never claim the extension blocks Alt+Tab, disables F12, detects phone use, or prevents all cheating.
6. **Respect platform boundaries.** Use Chrome extension APIs for browser events, Windows APIs for foreground-app metadata, and administrator-managed policies for lab lockdown.
7. **Do not embed or modify HackerRank.** Use the normal supported browser and obtain required approval before live deployment.
8. **Protect candidate data.** Do not add invasive monitoring or upload sensitive data without an explicit requirement, consent, and privacy review.
9. **Keep configuration documented.** Update `.env.example`, setup instructions, and deployment docs whenever configuration changes.
10. **Report honestly.** At the end of each phase, state what works, what is untested, known limitations, and exact commands/results.
11. **Do not silently add paid services.** Ask before introducing any dependency or hosting service that requires payment.
12. **Do not automatically disqualify candidates.** The system provides review evidence only.

## 10. First task for Claude Code

Start with **Phase 0 only**:

1. Inspect the repository and report its current structure.
2. Identify existing code or files that can be reused.
3. Propose the final folder structure and dependency choices.
4. Create the Phase 0 setup without overwriting existing work.
5. Add a short `docs/architecture.md` and `docs/test-plan.md`.
6. Run the available checks and report the results.


---

## Official documentation to consult during implementation

- Chrome Extensions — Tabs API: https://developer.chrome.com/docs/extensions/reference/api/tabs
- Chrome Extensions — Windows API: https://developer.chrome.com/docs/extensions/reference/api/windows
- Chrome Extensions — Manifest V3: https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3
- Chrome Enterprise policies: https://chromeenterprise.google/policies/
- Windows Assigned Access: https://learn.microsoft.com/windows/configuration/assigned-access/
- Microsoft Win32 API — `GetForegroundWindow`: https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getforegroundwindow
- Microsoft Win32 API — `GetWindowThreadProcessId`: https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid
- Supabase documentation: https://supabase.com/docs
- HackerRank terms and policies: https://www.hackerrank.com/terms-of-service

