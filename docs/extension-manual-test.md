# Chrome extension manual test

Unit tests use a simulated Chrome. Only this procedure confirms real browser behaviour.

## Setup

1. Start the API and create an active contest with one candidate; see `development.md`.
2. Run `npm run build`.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `apps/extension/dist`.
4. Add `chrome-extension://<id>` to `CORS_ALLOWED_ORIGINS`, and restart the API.
5. Pin **CodeWallah Exam Guard** to the toolbar.
6. Open any ordinary web page as the mock exam tab. Do not use a live HackerRank contest without the required permission.

Events appear in the dashboard timeline. The popup's **Recent events** only lists events not yet uploaded.

## Procedure

| #   | Action                                                           | Expected                                                                                          | Result |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| 1   | Open the popup with no session                                   | `Not monitoring`; badge `OFF`; monitoring notice shown                                            |        |
| 2   | Start without ticking the notice                                 | Session does not start                                                                            |        |
| 3   | Start with a wrong access code                                   | `incorrect` message; no session                                                                   |        |
| 4   | Start with valid details                                         | `Monitoring`; badge `ON`; `SESSION_STARTED` in the dashboard                                      |        |
| 5   | Switch to another tab, then back                                 | Two `TAB_ACTIVATED`: `is_exam_tab` false, then true                                               |        |
| 6   | Press Ctrl+T                                                     | `TAB_CREATED` with `opened_from_exam_tab: false`, plus `TAB_ACTIVATED`                            |        |
| 7   | Click a link on the exam page that opens a new tab               | `TAB_CREATED` with `opened_from_exam_tab: true`                                                   |        |
| 8   | Alt+Tab to Notepad, then back                                    | `BROWSER_FOCUS_LOST` (`outside_chrome`), then `BROWSER_FOCUS_RETURNED`                            |        |
| 9   | Open a second Chrome window, then return                         | One `BROWSER_FOCUS_LOST`, then `BROWSER_FOCUS_RETURNED`                                           |        |
| 10  | Press F11 to enter, then F11 to leave                            | `FULLSCREEN_ENTERED`, then `FULLSCREEN_EXITED`, both with `scope: browser_window`                 |        |
| 11  | Note the `detection` value in step 10                            | `window_state_event`; if `window_state_poll`, the timestamp can be about 30 seconds late          |        |
| 12  | Start page fullscreen, such as fullscreen video                  | **Discover and record** whether any event appears. No behaviour is promised                       |        |
| 13  | Open the popup while monitoring and close it                     | **Discover and record** whether focus events appear, since a false signal here must be documented |        |
| 14  | Stop the service worker on the extensions page, then switch tabs | The event is still recorded after the worker restarts                                             |        |
| 15  | Disable Wi-Fi, switch tabs, wait one minute, and re-enable Wi-Fi | Popup shows the server unreachable; events arrive later with `NETWORK_RECONNECTED`; no duplicates |        |
| 16  | Close the exam tab                                               | Badge `!`; popup shows the attention message; the next `TAB_ACTIVATED` has `exam_tab_open: false` |        |
| 17  | Start a new session, restart Chrome, and open the popup          | Session is still shown with the attention message                                                 |        |
| 18  | Click **End session**, then confirm                              | `SESSION_ENDED`; `Not monitoring`; the dashboard shows the session ended                          |        |
| 19  | Inspect all events                                               | Unique `event_id` values; no URLs, titles, page text, or code; no `EXAM_TAB_HIDDEN` or `VISIBLE`  |        |

Steps 12 and 13 cover behaviour that cannot be established from the documentation. Report their results so that the limitations can be updated.
