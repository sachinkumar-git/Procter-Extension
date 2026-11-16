# Lab deployment

For the contest organiser and college IT. Nothing here has been carried out on a lab machine yet.

## Before anything else

| #   | Question                                | Why it matters                                                                                                                                                                      | Owner     | Status |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------ |
| 1   | Does HackerRank permit this use?        | Its terms bar combining the service with third-party products "other than as authorized by HackerRank" (section 6.1) and do not address monitoring tools. Get written confirmation. | Organiser | Open   |
| 2   | Which Windows edition do lab PCs run?   | Assigned Access needs Pro, Enterprise, Education, or IoT Enterprise. Home is not supported.                                                                                         | IT        | Open   |
| 3   | Are lab PCs joined to Active Directory? | Decides how the extension can be installed (see below).                                                                                                                             | IT        | Open   |
| 4   | Where will the API and database run?    | Needs HTTPS, backups, and capacity proven by the Phase 6 load test.                                                                                                                 | IT        | Open   |
| 5   | Are the privacy decisions made?         | See `privacy-and-consent.md`.                                                                                                                                                       | College   | Open   |

## 1. Server

1. Provide PostgreSQL 13 or later and a Node.js 22 host. A college server avoids hosting fees but needs a reliable machine, backups, and IT support. Any free hosting tier must be checked against its current limits and proven under load first.
2. Put a reverse proxy with a valid TLS certificate in front of the API, and set `TRUST_PROXY_HOPS=1`.
3. Set environment variables from `.env.example`. `CORS_ALLOWED_ORIGINS` must list the dashboard origin and `chrome-extension://<EXTENSION_ID>`.
4. Run `npm ci`, `npm run build`, then `npm run start -w @exam-guard/api`. Migrations run at startup. Check `/readyz`.
5. Run only one API instance: rate limits are held in memory and the disconnect sweep runs in-process.

## 2. Contest setup

Run from the repository with `DATABASE_URL` set. Handle the access-code file as confidential, and delete it after the exam.

```sh
ADMIN_PASSWORD='...' npm run cli -w @exam-guard/api -- create-admin <username> admin
npm run cli -w @exam-guard/api -- create-contest <id> "<name>" <startISO> <endISO>
npm run cli -w @exam-guard/api -- import-candidates <id> candidates.csv codes.csv
npm run cli -w @exam-guard/api -- set-contest-status <id> active
```

## 3. Build the clients

Set `VITE_API_BASE_URL` to the HTTPS API address, then run `npm run build`. The build fails if the address is not HTTPS.

Set `api_base_url` to the same address in `apps/windows-agent/src/ExamGuard.Agent/agent.json`, then run `npm run publish:agent`. The output is in `apps/windows-agent/publish`, and the target PCs do not need .NET installed.

## 4. Install the extension

A website cannot silently install a Chrome extension. The choice depends on question 3.

| Route                              | Requirement                        | Cost and trade-off                                                                   |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| Self-hosted `.crx` with policy     | PCs joined to Active Directory     | No fee; IT hosts the file and update manifest                                        |
| Unlisted Chrome Web Store + policy | Chrome Web Store developer account | Google charges a registration fee (confirm the current amount); needs owner approval |
| Load unpacked on each PC           | Developer mode on each machine     | No fee; manual, and candidates can disable it. Suitable for small pilots only        |

The extension ID must be stable, as the API's CORS setting depends on it. A packed or store-published extension provides this; a load-unpacked ID depends on the folder unless a `key` is added to the manifest.

`deploy/chrome-policy.reg.example` shows the Chrome policies for IT to review.

## 5. Install the agent

1. Copy the published folder to a read-only location such as `C:\Program Files\CodeWallah\ExamGuard`, using IT's normal software process.
2. Start it per user at sign-in, such as through a shortcut in the all-users Startup folder. It must run in the candidate's own session, and does not need administrator rights.
3. The agent is unsigned, so Windows SmartScreen or antivirus may warn. A code-signing certificate usually costs money, so IT should allowlist it or the organiser should decide whether to buy one.

## 6. Lab restrictions (IT)

Software monitoring records signals; restrictions come from Windows and Chrome policy.

- Evaluate Assigned Access with a restricted user experience, allowing Chrome and the agent. Confirm the agent's tray icon is visible and it can start.
- Use `DeveloperToolsAvailability=2` if DevTools must be disabled. To fully block source viewing, also add `view-source:*` to `URLBlocklist`. This affects every user of the machine.
- Record which policies are actually applied on each lab image.

## 7. Pre-exam system check (each PC)

| Check                                                                  | Result |
| ---------------------------------------------------------------------- | ------ |
| Extension present, badge `OFF`                                         |        |
| Agent tray icon visible                                                |        |
| Candidate signed the notice                                            |        |
| Practice session starts; badge `ON`                                    |        |
| Agent pairs using the code in the popup                                |        |
| Candidate appears in the dashboard with both clients `Connected`       |        |
| Switching to Notepad and back appears in the timeline                  |        |
| HackerRank login, editor, code execution, and submission work normally |        |

## 8. Manual fallback

If monitoring or the network fails, the exam continues under invigilator supervision. Note the time and affected PCs. The dashboard reports `Monitoring unavailable`, which is not evidence of misconduct. Undelivered events are retried from each PC when the connection returns.

## Phase 5 acceptance status

| Criterion                                            | Status                                       |
| ---------------------------------------------------- | -------------------------------------------- |
| A pilot machine can install and start all components | Not done: needs a lab machine                |
| HackerRank's workflow works in the supported browser | Not done: needs a lab machine and permission |
| IT confirms the policies on each lab image           | Not done: needs college IT                   |
| A candidate completes a practice contest             | Not done: needs a pilot                      |
