# Windows agent manual test

Automated tests and a live API run cover the monitoring core. The tray interface and real application switching need this procedure.

Start the API, start a session in the extension, and run `dotnet run --project apps/windows-agent/src/ExamGuard.Agent`.

| #   | Action                                                   | Expected                                                                                  | Result |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| 1   | Start the agent as a standard user                       | Tray icon and monitoring notice appear; no administrator prompt                           |        |
| 2   | Open the tray menu                                       | Shows `Not monitoring: not paired`                                                        |        |
| 3   | Pair using a wrong code                                  | `That code is invalid or has expired.`                                                    |        |
| 4   | Click **Show agent pairing code** in the popup, and pair | Tray shows `Monitoring active`; dashboard shows the agent `Connected`                     |        |
| 5   | Reuse the same code from another pairing                 | Rejected                                                                                  |        |
| 6   | Switch from Chrome to Notepad                            | `FOREGROUND_APP_CHANGED`, `process_name: Notepad`, `is_approved_browser: false`           |        |
| 7   | Switch back to Chrome                                    | `FOREGROUND_APP_CHANGED`, `is_approved_browser: true`, labelled `Information`             |        |
| 8   | Confirm the event's details                              | No window title or document name                                                          |        |
| 9   | Stop the API, switch applications, restart the API       | Tray reports the server unreachable; events arrive later; `NETWORK_RECONNECTED`           |        |
| 10  | Exit from the tray                                       | `AGENT_HEARTBEAT` with `lifecycle: stopping`                                              |        |
| 11  | End the agent in Task Manager                            | `AGENT_DISCONNECTED` after the grace period; the dashboard shows `Monitoring unavailable` |        |
| 12  | Start the agent again                                    | Resumes without pairing; the dashboard shows `Connected`                                  |        |
| 13  | End the session in the extension                         | Agent returns to `Not monitoring` within one heartbeat                                    |        |

Switches shorter than the 250 ms polling interval can go unseen. A protected process can appear with `lookup_failed: true`.
