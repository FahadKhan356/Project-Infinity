# Brief vs. implementation: what is left to build

Audited 2026-09-26 against `brief.docx` (48 sections) at commit `adf1fb7` plus the uncommitted working tree; refreshed 2026-09-28 after thirteen fixes and two follow-ups landed, all still uncommitted.
Method: every bullet in the brief was checked against schema, server code and UI, with a file pointer as evidence. Each item below points at the code as it is now, not as it was audited.

## Verdict

The Phase 1 / MVP scope (brief §28) is fully implemented. No requirement in the brief is structurally missing. Of the partial implementations flagged on 2026-09-26, everything that was worth code is now built (§2); what remains is three small partials, ten decisions the client should take rather than the developers, and a short operational checklist. The app also goes well beyond the brief (invoices, sales pipeline, time tracking, client portal, AI summaries, multi-channel notifications).

Full suite on the current tree (2026-09-28): 840 tests pass, 0 fail, 0 skipped — 833 at the verification before the two follow-ups, which added their own tests to `tests/months.test.ts`, `tests/recurring.test.ts`, `tests/backup-health.test.ts` and `tests/health-route.test.ts`. Typecheck and lint clean.

Counts across all 48 sections:

| Status | Requirements |
|---|---|
| Implemented | ~215 at the 2026-09-26 audit, plus the items in §2 since |
| Fixed since the audit | 6 bugs (§1) + 3 items on 2026-09-26 + 13 items and 2 follow-ups on 2026-09-28 (§2) |
| Partial | 3 (§3) |
| Decisions still open | 10 (§4) — not defects, choices the brief leaves unclear |
| Missing | 0 |

The "~215" is the audit's figure and has not been recounted; the other rows are counted from the sections below.

## 1. Bugs (fixed 2026-09-26, uncommitted)

All six are fixed in the working tree, each with a test that failed before the change.

1. **Uploads on post-QA deliverables.** A new `uploadBlockedReason` rule in `src/lib/files/access.ts` refuses uploads to slots in PM QA, approved or delivered (a revision returns them to `changes_requested`). Enforced when the session opens, again at completion inside the row lock, and the workspace button follows it.
2. **Role-scoped permission grants.** `grantablePermissions(role)` in `src/lib/authz/can.ts` lists what each role may hold: Executives nothing; Team Leads pricing, exports, deletes; Sales all-clients, exports, deletes, reopen; PMs deletes, reopen. The admin form shows only those, the save refuses others, and `can()` ignores a stale row. (Since 2026-09-28 Sales, PMs, Team Leads and Executives may also be given the `no_download` restriction; see §2.)
3. **PM name on the project page.** Now always shown; price is a fifth tile for those who may see it.
4. **Activity feed truncation.** The feed fetches the newest rows and re-sorts oldest-first.
5. **Team Lead with no lead department.** The dashboard now explains the account is not yet a lead instead of showing management tiles.
6. **Copy month wiping the price.** A form with no price field keeps the source price; an emptied field clears it.

## 2. Fixed since the audit

### Fixed 2026-09-26

- **Month view (§33, §36, §48).** New page `/clients/[id]/months/[monthId]` shows a month's projects, final files, revisions, comments, people, delivery dates and activity to anyone who can see the client, scoped by project visibility. Month headings on the client page link to it; `/reports` shares the same view component (`src/lib/reports/monthly.ts`).
- **Comments in the month report (§33).** The report carries the comments themselves (author, text, where it was said), with revision threads under revision scope.
- **Client search (§48, the one "missing" item).** Global search has a Clients block that finds a client by name or company even with no projects, and the client list has a name filter (`src/lib/search/search.ts`).

### Fixed 2026-09-28

One line each; the file is where to look, the test is what proves it.

1. **Per-team PM QA (§13).** PM QA is a route per team: `project_departments.requires_pm_qa`, set on the triage panel (`src/app/triage/triage-panel.tsx:86`) and the project edit form (`src/app/projects/[id]/edit/edit-project-form.tsx:89`); `projects.requires_pm_qa` is only the intake default that seeds a team filed without its own answer (`src/lib/projects/triage.ts:145-161`). `tests/pmqa.test.ts`.
   - Follow-up: "Copy August → September" and the nightly recurring copy carry each team's own setting to the copied team; a team added in the copy takes the intake default (`src/lib/months/copy.ts`, `IntakeDepartment.requiresPmQa` in `src/lib/projects/file-project.ts`). `tests/months.test.ts`, `tests/recurring.test.ts`.
2. **Executive revision scope (§16).** An Executive sees revisions on a project where they hold an open assignment (planned, in progress or submitted) or that touch a slot assigned to them (`src/lib/authz/scope.ts:173-194`); the project page and the month archive read a project's revisions under the project rule with `history: true` (`src/lib/workspace/workspace.ts:306`, `src/lib/reports/monthly.ts:541`). `tests/revision-scope.test.ts`.
3. **Scheduled nightly jobs and job health (§20, §36, §44).** A `scheduler` Compose service runs the retention sweep, the recurring projects and the nightly housekeeping on busybox crond, before the backup (`docker-compose.yml`, `docker/scheduler/entrypoint.sh`); each run records itself under `STORAGE_ROOT/jobs` (`src/lib/jobs/runs.ts`), is stale after 36 hours (`src/lib/jobs/health.ts`), and is shown on the management dashboard and in `/api/health` as `jobs`. `tests/jobs.test.ts`, `tests/health-route.test.ts`.
4. **Missing file backup is loud, not silent (§44).** With `RESTIC_REPOSITORY` unset the nightly run still dumps but fails with `offsite: unconfigured` (`scripts/backup/backup.sh:173-184`), `npm start` refuses to start and `npm run dev` warns (`scripts/check-env.mjs:98-110`, `fileBackupPolicy` in `scripts/backup-env.mjs`), and the dashboard and `/api/health` read `unconfigured`. `BACKUP_FILES_DISABLED=1` is the one explicit opt-out (dumps only, recorded `disabled`). `tests/backup-env.test.ts`, `tests/backup-health.test.ts`.
   - Follow-up: the weekly rehearsal applies the same rule — `verify-restore.sh` still restores and compares the dump, then fails with `offsite: unconfigured` or passes with `offsite: disabled` under the opt-out (`scripts/backup/verify-restore.sh:197-231`); and `/api/health` carries `backupsReason`, the worst finding as one token, so a monitor can tell a same-disk repository from a stale backup or a failed rehearsal (`REASONS` in `src/lib/backup/health.ts`, `src/app/api/health/route.ts`; table in `docs/runbook.md`, "Monitoring backups").
5. **Management-wide activity log and delivery-received event (§25).** `/activity` lists who did what across every project, newest first, narrowed by client, project code, person, action or date, for anyone who sees every project (`src/app/activity/page.tsx`, `src/lib/activity/log.ts`, index `drizzle/0017_activity_log_created_idx.sql`). The moment an approved file reaches Sales' delivery queue is its own event, `delivery.received` (`src/lib/qa/review.ts:156-163`, wording in `src/lib/activity/describe.ts:141`). `tests/activity.test.ts`.
6. **Sales intake: other information, PO document, deliverable total (§3).** "Other relevant information" is its own column (`projects.other_info`, `drizzle/0016_intake_other_info_po_kind.sql`; form `src/app/projects/new/new-project-form.tsx:154`). The purchase order is an attachment of its own kind, `attachments.kind = 'po'`, always on the project, uploaded from the intake form and filed beside the PO reference on the project page (`src/lib/files/attachments.ts`, `src/app/projects/[id]/page.tsx:90-96`). The deliverable total is the sum of the teams' counts, read where it is shown so it can never disagree with them (`src/lib/projects/queries.ts:25`; project page and triage list). `tests/intake.test.ts`.
7. **Comment threads on file versions (§10, §19).** `comments.version_id` (`drizzle/0018_version_comments.sql`); each version carries its own thread under it in the workspace, posted from an inline form (`src/lib/workspace/comments.ts`), the uploader and the slot's executive are notified (`onVersionCommented` in `src/lib/notifications/notify.ts`), and the month report lists it as "Thumbnail 01 v3" (`src/lib/reports/monthly.ts`). `tests/workspace.test.ts`.
8. **Single PM overall planning view (§6).** `/planning` carries a cross-department Teams section under the project board: every production team, its leads, every member with their workload (open slots, in QA, due within seven days) and each active assignment with project code, client, dates, approved/total progress, status and deadline, each linking into `/planning/[teamId]`. The PM sees every team; a Team Lead the departments they lead (`planningRoster` in `src/lib/planning/roster.ts`, `src/app/planning/page.tsx`). `/teams` remains as the summary view. `tests/planning.test.ts`.
9. **Month archive shows every deliverable and version (§33, §36).** The month page and report list every slot (team, assignee, status, due date) with every version — uploader, date, QA verdicts and the uploader's note — not only the current file of approved slots; a file link is withheld wherever `decideFileAccess` would refuse the download (`src/lib/reports/monthly.ts:634-690`, `src/app/clients/[id]/months/[monthId]/page.tsx`). The "Final approved files" block is unchanged. `tests/reports.test.ts`.
10. **Client overview: current month block, percentages, previous months toggle (§35, §39).** The current month — the open month that holds today — sits on top in its own block, months opened ahead are shown apart, and everything earlier is folded under a "View previous months" toggle with each month's status (`currentMonthOf` and `progressPercent` in `src/lib/months/queries.ts`; `src/app/clients/[id]/page.tsx:146-190`). Each order shows approved/total and the whole percent (`src/app/clients/[id]/month-card.tsx:115-120`). `tests/w3-clients.test.ts`.
11. **Search: created-date and delivered-date filters (§22).** `created_from/to` and `delivered_from/to` beside deadline and month; a project counts as delivered in the range when any of its deliveries was marked delivered then (`src/lib/search/search.ts:46-56, 211-217`; `src/app/search/page.tsx`). `tests/search.test.ts`.
12. **Department performance: on-time rate and throughput (§21).** The management by-department table adds throughput (slots approved in the last 30 days) and an on-time rate (the last 90 days' approvals against the slot due date, or the project deadline when it has none) (`src/lib/dashboard/dashboard.ts:10-16, 201-222`; `src/app/dashboard/page.tsx:244-297`). `tests/dashboard.test.ts`.
13. **Separate download control from view (§43).** Downloading is a right of its own, `files.download`, held by every staff role; an administrator withholds it per account with the `no_download` restriction on the user page (`drizzle/0019_download_restriction.sql`, `src/lib/authz/can.ts:88, 120-123`, `src/lib/files/access.ts:137`). The file route answers 403 for attachment downloads while inline viewing and previews keep working, and the workspace, QA, delivery, revision and month pages show plain text instead of a link. `tests/files.test.ts`, `tests/authz.test.ts`.

## 3. Partial implementations worth finishing

**Planning (§6)**
- Workload is counted in open deliverable slots, not hours (`src/lib/planning/roster.ts`, `src/lib/planning/workload.ts`); the dashboard says so beside the figure. Hours would need the time-tracking data joined in.

**Files and workspace (§10)**
- Plain attachments (references, the PO document) have no comment thread and no status; only deliverable versions do (`drizzle/0018_version_comments.sql`).

**Client overview (§35)**
- The four tiles at the top of the client page (current month, active, completed, total months) still count the client's whole visible history (`src/app/clients/[id]/page.tsx:129-134`); the month-by-month numbers are in the blocks beneath.

## 4. Decisions still open

Deliberately not changed on 2026-09-28. Each needs the client's answer, not more code, before anyone touches it.

1. **Progress counter ticks on approval, not upload (§11).** The headline approved/total comes from `v_project_progress` (`drizzle/0001_init.sql:501-508`) and counts accepted slots; the workspace shows uploaded beside it (`src/lib/workspace/workspace.ts:208`), and the client-page percentage follows the same rule (`progressPercent`, `src/lib/months/queries.ts:192`). The brief's example ticks on upload.
2. **No hard "rejected" state (§12).** `QaDecision` has `rejected` and demands a reason, but both verdicts land the slot on `changes_requested` (`src/lib/qa/review.ts:93-96, 124-126`). A reject that discards the version is a new state.
3. **No PM gate on revisions before the Team Lead (§17).** `onRevisionCreated` notifies Sales, the PMs and the leads of the touched departments in one go (`src/lib/notifications/notify.ts:467-491`).
4. **`approved` project status is never set (§18).** It is in the enum and folded into `ready_for_delivery` (`src/lib/qa/project-status.ts:52-56`). Remove it or give it a meaning.
5. **Bare-IP access is refused by design (§40).** The portal answers on `PORTAL_HOSTNAME` only, http redirected to https (`docs/runbook.md:24-33`); the brief's `http://192.168.x.x/` example is met by the name resolving to that address. Confirm with the client.
6. **RTO is unmeasured and there is no point-in-time recovery (§44).** RTO is to be measured in the rebuild drill and written into `docs/runbook.md:673-678`; PITR (WAL archiving) is described there as the way to bring RPO from a day to minutes, and not built.
7. **The scheduler runs from the migrator image, not the runner image.** The `scheduler` service is the build stage with the full toolchain, because the standalone runner carries neither `tsx` nor `scripts/` (`docker-compose.yml`, `Dockerfile` migrator stage). It works and is documented; the trade is a second, larger image that must be rebuilt when the scripts change.
8. **An Executive whose only assignment on a project is completed reads its revisions but cannot act on them (§16).** The project page and month archive list them under `history: true` (`src/lib/workspace/workspace.ts:306`), while commenting and attaching use the default scope, which needs current work (`src/lib/workspace/comments.ts:65`, `src/lib/revisions/revisions.ts:171`). Narrowed by the revision-scope fix; confirm that a closed round is meant to be read-only for them.
9. **Attachment purpose "PO / brief" is now "brief" (§3).** The label lives in `src/components/files/attachment-list.tsx:13-18`; the PO document is classified by `kind`, not by that free label. The migration reclassified only files filed with purpose `po` on a project (`drizzle/0016_intake_other_info_po_kind.sql`); anything filed earlier under `brief` keeps that purpose and stays a reference. Decide whether those need a hand pass.
10. **Department figures are computed for every non-executive role and hidden by the page (§21).** `src/lib/dashboard/dashboard.ts:168` builds the by-department rows for PMs, Sales and leads too; the page keys the throughput and on-time columns on ceo, coo and admin (`src/app/dashboard/page.tsx:32, 263-268`). Harmless, but the rule lives in two places.

## 5. Operational items to close before go-live

- **Docker path: nothing to schedule by hand.** `docker compose up -d --build` starts the `scheduler` (sweep 02:00, recurring 02:15, nightly 02:20) and the `backup` service (02:30 nightly, rehearsal Sunday 04:30) with the stack, all in `BACKUP_TZ`. A plain `npm` install still needs cron, launchd or Task Scheduler for `backup`, `backup:verify`, `files:sweep`, `projects:recurring` and `jobs:nightly` (`docs/runbook.md`, "Backups without Docker" and "Scheduled jobs").
- **Choose and set the off-box target.** `RESTIC_REPOSITORY` and `RESTIC_PASSWORD` — the NAS at `BACKUP_REPO_HOST_DIR`, or an `sftp:`/`s3:`/`b2:` URL — before the first production start: without them `npm start` refuses, every nightly run and weekly rehearsal fails, and health reads `unconfigured`. `BACKUP_FILES_DISABLED=1` only for a machine whose files are backed up some other way you can name. Keep `RESTIC_PASSWORD` in the password manager, not only in `.env`.
- **Point a monitor at `/api/health`.** It answers HTTP 200 always and carries `backups`, `backupsReason` and `jobs` for an external check; the dashboard banner is for people who are logged in.
- **Run the rebuild drill and write the RTO** into the runbook (§4, item 6). Point-in-time recovery stays a decision, not a task.
- **Bare-IP access** stays a decision (§4, item 5).

## 6. Deliberate deviations to confirm with the client

- "Project Closure Report" is the nav label, but the route is `/triage` and the PM assigns a Team Lead **per department**, not one per project.
- PMs see every project (`projects.viewAll`), not only "assigned" ones.
- Sales cannot choose a PM; the PM is whoever saves the routing.
- Executives see a project only once they hold an assignment, not when it is merely planned for their team.
- Executives see client notes but not internal notes.
- Approval forwards automatically; there is no separate "Forward" button.
- "Revision Required" cannot be picked by hand on a delivery; it is set by opening a revision.
- Project ID year comes from the work month chosen at intake, not the filing date.
- Adding brand-new projects during "Copy previous month" goes through the separate New Project button (`src/app/clients/[id]/months/[monthId]/copy/copy-form.tsx:175`).
- Project completion requires Sales to mark each delivery "Completed"; "Delivered" alone leaves the project at `delivered`.
- PM QA is answered once by Sales at intake and then per team by the PM; a month copy keeps each team's answer.

## 7. Beyond the brief (already built)

Invoices and billing settings, sales pipeline/opportunities, time tracking and cost rates, productivity reports, client portal with client login and approvals, email/Slack/WhatsApp channels, AI project summaries and forecasts, recurring projects, read-only project shares, resumable uploads with previews, restic backups with restore rehearsal, a scheduler service with job health, a management-wide activity log. Most of these are listed under brief §29 "Future Features".
