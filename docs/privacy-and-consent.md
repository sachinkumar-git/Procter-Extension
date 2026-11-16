# Privacy and consent

For the college to review and adapt. This is not legal advice; the college should confirm its obligations under applicable law, such as India's Digital Personal Data Protection Act.

## What is collected

| Source           | Data                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Registration     | Contest ID, candidate ID, optional display name                                                                     |
| Chrome extension | Timestamps of tab switches, new tabs, browser focus changes, and browser fullscreen changes; tab and window numbers |
| Windows agent    | Timestamps of foreground application changes, process name and process ID, agent start and stop                     |
| Server           | Receipt times, heartbeat status, administrator sign-ins, timeline views, and exports                                |

## What is never collected

Keystrokes, clipboard contents, passwords, screen recordings, page contents, website addresses, page or window titles, source code, webcam, or microphone.

Candidates should know that a process name can occasionally reveal something personal, such as the name of an application they opened.

## How the data is used

Events are signals for an invigilator to review with the full timeline and context. No candidate is disqualified automatically, and no single event is treated as proof. A monitoring outage is not evidence of misconduct.

## Candidate notice (template)

> **CodeWallah Exam Guard monitoring notice**
>
> During this exam, [COLLEGE NAME] will record activity signals from this computer: switching Chrome tabs, opening new tabs, Chrome losing focus, the browser entering or leaving fullscreen, and the name of the application in the foreground.
>
> We do not record your keystrokes, clipboard, passwords, screen, webcam, microphone, the websites you visit, or your code.
>
> An invigilator reviews these signals alongside other context. A signal alone is not proof of misconduct, and technical problems can cause false signals.
>
> Records are kept for [RETENTION PERIOD] and then deleted. To ask a question, correct a record, or report a false flag, contact [NAME AND CONTACT DETAILS].
>
> Signature: [SIGNATURE] Date: [DATE]

## To be decided by the college

| Item                                  | Owner             | Status |
| ------------------------------------- | ----------------- | ------ |
| Lawful basis and consent wording      | College           | Open   |
| Retention period                      | College           | Open   |
| Contact for false flags               | College           | Open   |
| Alternative for candidates who object | College           | Open   |
| Who may have dashboard access         | Contest organiser | Open   |

## Deleting data

After the retention period, run `npm run cli -w @exam-guard/api -- purge-contest <id>`. This permanently deletes the contest, its candidates, sessions, and events. Delete exported CSV files and access-code files separately. The extension and agent also keep undelivered events locally until they are sent, or until they are removed from the computer.
