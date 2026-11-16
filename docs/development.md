# Local development

## Prerequisites

| Tool          | Version     | Needed for                                 |
| ------------- | ----------- | ------------------------------------------ |
| Node.js       | 22 (≥22.12) | Everything except the Windows agent        |
| npm           | 10          | Workspace package manager                  |
| .NET SDK      | 10 (LTS)    | Windows agent only; Windows machine needed |
| Google Chrome | Current     | Loading the extension                      |

If the .NET SDK is not on `PATH`, the root `build` and `test` commands print `SKIPPED` for the agent. Set `REQUIRE_DOTNET=1` to turn that into a failure, as CI should.

## Root commands

```sh
npm ci                # clean install
npm run check         # format check, lint, typecheck, test, build
npm run build
npm test
npm run lint
npm run typecheck
npm run format
```

## App commands

| App           | Local development command                                                                         | Current state                                |
| ------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| API           | `npm run build:shared`, then `npm run dev -w @exam-guard/api` (needs `DATABASE_URL` in `.env`)    | Express API                                  |
| Admin         | `npm run build:shared`, then `npm run dev -w @exam-guard/admin`, and open <http://localhost:5173> | Dashboard                                    |
| Extension     | `npm run build:shared`, then `npm run dev -w @exam-guard/extension`                               | Monitors browser activity and uploads events |
| Windows agent | `dotnet run --project apps/windows-agent/src/ExamGuard.Agent`                                     | Tray agent; set the server in `agent.json`   |

To load the extension: open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/dist`.

## Local database and first contest

PostgreSQL 13 or later is required for the API. Automated tests do not need it: they use PGlite.

Set `DATABASE_URL` in `.env`, add your extension's origin to `CORS_ALLOWED_ORIGINS` as `chrome-extension://<id>` (the ID is shown on `chrome://extensions`), and then follow "Contest setup" in `lab-deployment.md`.

## Manual tests

See `extension-manual-test.md` and `agent-manual-test.md`.

## Configuration

Copy `.env.example` to `.env`. Never commit `.env`. Values prefixed `VITE_` are compiled into the public dashboard bundle, so they must never hold secrets.
