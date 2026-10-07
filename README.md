# Aktivacity Central Project Portal

Internal production system for Aktivacity: one record follows a job from Sales
intake through PM triage, team planning, production, QA and delivery, with
monthly history retained per client.

Runs entirely on Aktivacity's internal server — no cloud hosting, no internet
dependency for core functionality (brief §40–46).

## Documentation

| Document | Purpose |
|---|---|
| `brief.docx` | The original client brief |
| `docs/phase-1a-plan.md` | Scope, stack, milestones M0–M7, open questions |
| `docs/runbook.md` | Deployment and operations |
| `drizzle/0001_init.sql` | **The data model. Source of truth.** |

## Current state: Phase 1 complete

The spine works end to end on one server. Sales files a project; the Project
Manager routes it to the teams that will deliver it; Team Leads plan their
team's work and open its deliverable slots; an Executive uploads against a
slot; the Team Lead — and, where the team requires it, the Project Manager —
approves or sends it back; Sales sees the approved file in their delivery queue
and records what happened with the client. Every step is permission-checked,
and every step is in the activity log.

Underneath: authentication with forced first-password change and per-user
permission grants; a policy layer that every list query composes; resumable
uploads and permission-gated downloads; and one `Client → Month → Project`
record that all of it hangs off.

Phase 1b added **revisions**, the **monthly archive** (close, reopen,
copy forward, month summaries), **global search**, **notifications** and
**per-role dashboards**. The last of the brief's Phase 1 is also in:
**On Hold / Cancelled**, **attachments** on projects, assignments and
revisions, **file deletion**, **Reports** with CSV export, **Team Overview**,
and **automated backups with a restore rehearsal** (below). A final sweep
(25–26 September 2026) went through the brief section by section and closed
the remaining gaps between it and the portal — the brief's own names and
wording, what each role sees on their list, per-version QA history, stored
deadline reminders and the automatic month archive — with the details in the
sections below and the tests in `tests/w3-*.test.ts`. What remains is
deployment on the real server and a rehearsed rebuild there
(docs/runbook.md).

### Clients, months and intake

`Client → Month → Project` is the spine (brief §34, §47), and it is enforced
rather than encouraged:

- **The client is chosen, never typed.** The intake form offers a select of
  clients the filer can see, plus a link to create the record first. A unique
  index on `lower(name)` refuses a case-variant duplicate, which is what keeps
  a client's years of history attached to one profile.
- **Filing a project opens its month.** Two projects filed for the same client
  and period land in one bucket; a concurrent race settles on one rather than
  creating two. For planning ahead, the client page has **Create new month**
  with a button "+ Create October 2026" — the month after the newest on the
  client's record, or the current month for a new or dormant client (§37). It
  never re-asks for client details, and it says what it did: "October 2026
  created.", or "… is already open." when nothing needed doing.
- **The PO travels with the project.** The intake form takes the PO document
  in a field of its own and the brief and reference files in another, and
  attaches them as the project is filed (§3). The PO is an attachment of kind
  `po`, always on the project itself: the project page shows it in a "PO"
  block beside the PO reference, with "Add PO document" for Sales and the
  Project Manager (the people who edit the order; an executive who can see the
  project cannot file its PO), while brief and reference files stay in the
  attachments list, tagged "PO / brief" from intake so the Project Manager can
  tell the order's paperwork from a stray reference (§5). A plain reference
  attached later has no tag. Reading a PO follows the same project rule as
  every file.
- **"Other relevant information"** (§3) is the last intake field: a free
  text on the intake and edit forms, shown on the project page to anyone who
  can see the project, and copied forward with the order when a month is
  copied.
- **The number of deliverables** is one figure on the intake queue, the
  projects list and the project header — the sum of the teams' counts, never
  a stored number that could disagree with them once triage changes a team.
- **"Client since"** is the day the client was created unless Sales types
  another date (§31). A prospect from the pipeline has no start date until the
  day it becomes a client — by winning a deal into a project, or by switching
  its status to active — and a date typed on the edit form wins.
- **Project codes** are `AKT-YYYY-NNNN`, issued by a counter that takes the
  greater of its own next value and the highest code that actually exists — so
  a restored database or a hand-inserted row corrects itself instead of
  colliding.
- **Deliverable counts are per team.** One project can need Video and Design
  with different quantities (§10), which is what M5 turns into slots.

Pricing is accepted only from someone allowed to see it, so a replayed form
cannot set a price its sender was never shown.

### Routing (PM triage)

`/triage` is the Project Manager's intake queue, and it is called what the
brief calls it: the **Project Closure Report** (§4, §5) — in the navigation,
as the page heading, on the dashboard ("New projects in the Project Closure
Report"), in the hint under the intake form and in the "New project" notices
("waiting in the Project Closure Report for a Project Manager") — though it
holds newly filed projects awaiting routing rather than closures. Only the
URL and the code keep the working name.

Routing happens inline on the project page, so the objective, PO and
requirements sit directly above the decision. A Team Lead is assigned **per
department**, not per project:

- A lead can only be given a team they actually lead — otherwise QA would show
  them deliverables they have no standing to judge.
- Routing every team moves the project to `planned`; routing some of them
  leaves it `awaiting_assignment` and in the queue, so partial work looks
  unfinished rather than scheduled.
- A team can be added during triage, and removed only while it has no work.

`/planning` is the overview (§6): one row per team of every live project —
the project, client and month, the team and its lead, who on the team holds
work (each person once), the project status, the planned count, progress as
approved slots out of those opened, the span of the planned dates and the
deadline. The Project Manager sees every row, including a team the PM has not
yet given a lead ("not assigned", nobody yet, no dates). A Team Lead — or a
co-lead of the same department — sees the rows for the teams they lead once
that team has a lead, and nothing from any other team on the same project.

### Planning and assignment

Opening a row reaches that team's board: what Sales promised, what has actually
been planned, the team's workload, and the assignments already made.

Assigning work **opens all of its deliverable slots in one action** — twenty
designs is one decision, not twenty forms. Slots are numbered per team and
continue from what exists, so a second assignment starts where the first
stopped and numbers never collide. A slot is the unit of progress; files attach
to it as versions (§11, §19). The assignment form also takes the briefs,
examples and brand files for the work (§7 "attachments/references"): they are
attached to the assignment as it is created and sit on its row in the
workspace for whoever does the work.

Guardrails: work can only be given to a member of that team, only by a lead
of that team or the Project Manager, and a refused assignment leaves no orphan
slots behind. The "Plan this team" link on the project page follows the same
rule, so a co-lead of the department sees it too, not only the lead named on
the team.

**Workload** means open deliverable slots — those not yet approved — plus how
many are in QA and how many are due within a week. It is committed work, not an
estimate of hours; there is no time tracking in Phase 1.

### The executive workspace

`/work` is an Executive's landing page (brief §8): the assignments they hold,
split into **current** and **previous**, with a **Today** section above them
for the current assignments whose planned dates include today (§21). Either
side closing moves a row to previous — a finished assignment, or a project
that was completed or cancelled under it — so history stays reachable without
cluttering the desk. Each row shows the project, the assignment, its dates,
deadline, priority and status, and under **Progress** the approved count
("0/2"), the uploaded count beneath it ("1/2 uploaded" after the first upload
— the brief's §7 example, while the main counter waits for QA), "N in QA" or
"N to redo" when that applies, and an expandable list of the slots themselves
by name and status. The **Revision** column opens the revision list filtered
to that project, and the **Comments** column lands on the project's thread.

Opening a project reaches the **shared workspace** (§9, §10), which is the same
for everyone on the project: every team, who is doing what and by when, each
deliverable slot with its current file and its earlier versions, and one
comment thread. A Video executive sees the Design thumbnails; neither sees the
price, because pricing is a field of the project record, gated separately, and
simply not part of the workspace shape.

What differs by person is the **Upload** button. It appears on a slot for its
assignee, for a lead of that slot's team, and for the Project Manager — the
same rule `POST /api/uploads` enforces, exported from one place so the page
and the API cannot disagree. The button drives the resumable protocol below
from the browser: a dropped chunk asks the server where it stands and resumes,
and only a refusal surfaces as an error.

The first file to arrive moves its assignment — and a project still marked
`planned` — to `in_progress` (§18). A note typed at upload time is stored
with that version, and each version shows its note and every QA round made
on it — reviewer, verdict, stage, time and comment — so a Team Lead approval
followed by a PM rejection of the same file are both on record, and the
earlier versions keep their own history under "N earlier versions" (§10,
§19). The assignment row shows the uploaded count beside the approved one
(§11). Comments attach to the project or to one slot and are visible to
anyone who can see the project; nothing can be said about a slot the author
cannot see.

### QA

`/qa` is one page with two audiences (§12, §13). A Team Lead sees the slots in
their teams that are `awaiting_lead_qa`; a Project Manager sees the slots
everywhere that are `awaiting_pm_qa`. The stage is read from the slot, never
chosen by the reviewer, so a lead cannot sign off at the PM stage and a
designer's lead cannot judge a video.

Three decisions, one comment box. **Approve** passes the slot to the PM if
that team requires PM QA, otherwise straight to `approved` and into Sales'
delivery queue — or, for a client with automatic portal delivery, straight to
the client portal, and the confirmation says so. **Request changes** and
**Reject** both return it to the Executive as `changes_requested`, with the
comment shown on their slot; a rejection must say why, and an empty reason is
refused before anything is recorded or sent. A re-upload after that is a new
version of the same slot, so a deliverable rejected twice still counts as one
— the number nobody sees move is the point.

Every round is appended to `qa_reviews`; nothing is overwritten, and each
version lists its own rounds in the workspace and on the revision page (§19).
Whether a team needs PM QA is per team (`project_departments.requires_pm_qa`),
seeded from the project at intake, and silence from the PM at triage leaves it
alone. The brief's "Approved" and "Ready for Delivery" (§18) are one moment
here: a file that clears its final QA is queued for Sales in the same
transaction, so the project shows `ready_for_delivery` and no separate
approved stage exists — a design decision recorded in docs/phase-1a-plan.md
to confirm with the client.

### Deliveries

`/deliveries` is Sales → Deliveries (§14): each approved file with its version,
a QA column with each sign-off — the stage, the reviewer, the time and what
they said — and the five statuses in the brief. Transitions are ordered — a
file cannot be `completed` before it has been `delivered` — and marking it
delivered records who and when. **Revision required** is not chosen by hand:
opening a revision sets it, and while the revision is open the row offers no
move and says the reworked file will arrive as a new delivery once it clears
QA. A revision ended before then — closed or cancelled by Sales, or withdrawn
when the Project Manager cancels the project — gives the row its delivered
state back, the normal moves with it: the file the client has stands, even
after a rework QA sent back, and nothing stays flagged for a revision that no
longer exists. The Project Manager sees the same list read-only; a rep sees
their own clients' deliveries, and a project shared with them to read is
listed with no moves. The portal does not send the file; it records that a
person did — unless the client has automatic portal delivery switched on
(below).

Project status follows the work from here (§18, §26): every slot approved →
`ready_for_delivery`; every slot delivered → `delivered`; every delivery
completed → `completed`, with `completed_at` set. An assignment closes when its
last slot is signed off.

### Revisions

When the client comes back, Sales opens a revision from the delivery panel or
the project (§15): a title, the client's words, details, which deliverables it
is about, priority and deadline, the client's reference files (attached to the
revision in the same step and tagged "client reference") and an optional
comment — an internal note for the team, posted as the first comment on the
revision by whoever opened it. Numbering is per project and written
"Revision #03" wherever it appears — the list, the inbox, the assignment it
becomes, the activity feed — so the client's "#03" is ours. Opening one does
three things at once: the slots go back to `changes_requested` (so the
Executive's list says "to redo"), the delivery that came back is marked
`revision_required` (§14), and the project says `revision_required` (§18).

Who sees it is `revisionScope` in the policy layer (§16): a revision is
visible when its project is, and a Team Lead additionally sees only the ones
touching a deliverable in their team — the Design lead does not see the note
about the video. The Executive sees it on their slot in the workspace, client
feedback and all.

The Team Lead hands it out from the revision page (§17): the slot moves to an
open assignment of the chosen Executive on the same team, or a new one titled
"Revision #03:" plus the revision's title, with the feedback as its
instructions. The slot never moves
teams and is never duplicated, so history stays on "Video 01". A hand-off is
refused while the project is on hold or cancelled, and the revision page says
so under the deliverables table; a completed project still takes rework,
since feedback after completion is what a revision is. The Executive's
upload is tagged with the revision and becomes the next version of the same
slot; QA and delivery run exactly as before. The revision's status is derived
from its slots — `assigned`, `in_progress`, `awaiting_qa`, `approved`,
`delivered` — and only `closed` and `cancelled` are decisions, made by Sales
or the PM, and only while the month is open: in an archived month the buttons
are gone and the server refuses the action until management reopens the
month. Either ending — and a project cancellation, which withdraws its open
revisions — gives each slot whose rework has not cleared QA (none uploaded,
or one QA sent back) its previous state back, delivered or approved, and the
delivery flagged for it with it (`restoreRevisedSlots`); a rework still in
QA decides for itself when the revision alone ends and goes with the project
when it is cancelled, and a slot another open revision still wants stays
sent back. The project then follows the work again. The revision page lists
each uploaded version with its QA rounds in order, or "Awaiting QA".

### The monthly archive

A client's history is read by the month (§33), so the month is the unit that
closes:

- **Closing.** Sales or the Project Manager closes a month from the client
  page (§36). It closes only when every project in it is completed or
  cancelled — and a cancelled project whose approved file still waits in
  Sales' delivery queue keeps it open; otherwise the refusal names the
  projects still open, such a one as "(cancelled, an approved file still
  awaits delivery)". Closing also closes every revision in the month whose
  slots were all delivered again, in the same step, recorded as "closed
  revision #01 with the month", so an archived month lists no open
  revisions. An empty month closes freely. The client page shows who closed
  it.
- **Closing automatically.** The nightly job (`npm run jobs:nightly`, under
  Notifications below and in docs/runbook.md) archives a month on its own
  once its period has been over for seven days and every project in it is
  completed or cancelled, so a late order or a last file still lands. No
  closer is named: the client page says "closed automatically" and the
  month's activity reads "September 2026 was archived automatically" (and
  "Revision #01 was closed automatically when the month was archived" for
  each delivered revision it closed with it). An empty month is left open, a
  project reopened as the archive reaches its month keeps the month open, and
  a month management reopened is never taken back: it stays open until
  someone closes it by hand (`client_months.reopened_at`, migration 0015),
  marked "reopened" on the client page meanwhile. `closeSettledMonths` and
  `runRecurring` take an optional client filter, which the tests use; the
  scripts run for every client.
- **Read-only, everywhere.** Once closed, every mutation on a project in that
  month is refused server-side — filing into it, triage, assignment, upload
  (both at the gate and again when an in-flight upload completes), QA,
  delivery, comments, revisions, internal notes. The rule is one function,
  `assertMonthOpen`, called by each module before it writes; the workspace
  carries a `monthClosed` flag so the page offers no buttons it would refuse.
  The close takes the month row under lock, so filing into a month or copying
  into it either finishes before the close or is refused after it; nothing
  lands in a closed month from a write that started a moment earlier.
  Reading is untouched: the archive is there to be read.
- **Reopening** is a separate capability (`month.reopen`: management and
  admin, or a per-user grant), so Sales cannot unlock what they archived. The
  reopen is kept on the month, which is what the nightly archive reads to
  leave it alone (above); closing it again by hand clears it.
- **Copy forward** (§38). From any month with projects, "Copy to next month"
  lists every live order in it with the parts Sales may change — name, teams
  and quantities, deadline (moved forward by the same gap), price,
  requirements, notes — each ticked by default. Untick a project to leave it
  behind, untick a team to drop it, or tick a production team the original
  did not have (marked "(add)"). The target is chosen at the top of the page
  under "Copy into"; changing it reloads the plan, so the suggested deadlines
  and the note saying whether that month will be opened, is already open or
  is closed are for the month actually chosen. Something typed there that is
  not a month (or a hand-edited `?to=` in the URL) is not a 404: the page
  loads with the default target and a note under the field says to enter it
  as YYYY-MM. Each copy is a new project
  with a new code, filed as `new` for the Project Manager, with
  `copied_from_project_id` recording where it came from; a copied recurring
  order keeps repeating, and the monthly job continues from the copy. Nothing
  else travels: no slots, assignments, files or revisions. The whole copy is
  one transaction into an open (or newly opened) target month.
- **Month summaries** (§35, §39). Each month on the client page reports its
  projects — "2 projects, 1 cancelled": cancelled orders are counted apart
  from the live ones and stay in the list beneath, struck through, so the
  count and the list agree — delivered/total deliverables, what is ready to
  deliver, in QA, in revision or pending, and the teams involved. The parts
  add up to the total, cancelled projects' slots are left out (the month
  report leaves cancelled projects out altogether), and the line is scoped
  exactly as the
  month's report is: an Executive's numbers cover only the projects they can
  open, a Team Lead's only their teams' slots, and a project shared with a
  Sales rep counts for them here and opens in the report, though it never
  sums into their own portfolio report. "Current month" is the open month
  that contains today (in UTC, like every month here); a future month opened
  for planning does not become current, and only when nothing is open this
  month does the newest open month stand in.

### Search

`/search` (and the box in the header) finds projects by every field brief
§22 lists — name, code, client or company, team, team lead, executive,
deliverable name, file name, revision title or the client's words — and
filters by status, team, client, team lead, executive, delivery status,
month, deadline, created-date and delivered-date ranges and "has an open
revision". Each hit says which field matched. It is one query composed with
`projectScope`, so the brief's acceptance case holds by construction: an
Executive searching a colleague's name finds nothing they could not already
open. Revision text is further gated by `revisionScope`, and the people
filters are offered only to roles that see across teams. Searches are plain
GET URLs, so they can be shared.

### Notifications

Every step on the spine tells the people it concerns (brief §20), inside
the same transaction that makes the change, and never the person who did
it. Filing tells the Project Managers; routing tells each newly assigned
Team Lead ("New project for your team") and the Sales owner — once per team
that gained a lead, so re-saving the routing with the same leads tells
nobody — and a PM whose project another PM re-routed hears "Team Lead
assigned"; an assignment tells its Executive, as "New project assigned" the
first time they are given work on that project and "New task" after that; an
upload tells the lead of that team and the PM on the project; QA tells the
Executive — "approved by your Team Lead" when the file moves on to PM QA,
"approved for delivery" when it clears, or sent back — the PM when its
sign-off is needed, the lead when the PM overrules them, and Sales when a
file is ready for delivery or was rejected; a revision tells the PM, the
leads of the teams it touches and the Executives on those slots; handing a
revision out tells the person it went to, the lead of the team whose slot
it is — found by the slot's id, so two teams' same-named "Deliverable 01"
cannot tell the wrong lead — and the PM. When a client has automatic portal
delivery, Sales is told "Delivered to the client portal" instead of that the
file waits in their queue, and the Executive's notice says it went to the
client.

Deadlines are handled twice over. The inbox computes a live **Deadlines**
list from the work when opened — projects due within three days or overdue
for anyone who sees them, assignments for the person doing them and their
lead, revisions still to hand out — and each row is labelled project,
assignment or revision and links to that thing: the project, the workspace,
or the revision page. The nightly job (`npm run jobs:nightly`; in Docker the
`scheduler` service runs it nightly — docs/runbook.md, "Scheduled jobs")
also stores a reminder as
an item crosses each line — "Deadline approaching" once when it comes within
three days, "Due today" once, then "Overdue" or "Project delayed" once and
again weekly while it stays overdue — so people who have not opened the
inbox, and the optional email, Slack and WhatsApp copies, still hear.
Reminders go only to the people on the work: Executives and Team Leads for
their tasks, the Project Manager for the projects they manage (and for
anything still waiting in the Project Closure Report, which every PM hears
about), and the Sales rep for their own projects — the ones they filed, own
or whose client they own, never one a colleague only shared with them to
read, which the live Deadlines list and the "N due" badge still show. The
CEO, COO and administrators get none; their dashboard shows the delays. The
same item can sit in the live list and as a stored reminder until the
reminder is read.

The inbox is at `/notifications`. The header carries two badges on it: the
unread count, and "N due" — what is due or overdue within the inbox's
three-day window, computed live and falling as work is done. Opening a
notification marks it read and lands on what it is about.

### Dashboards

`/dashboard` is one page whose tiles and tables depend on the role (brief
§21), and every number on it is the same scoped query as every list — a
Team Lead's counts are counts over the projects they can open. Management
sees active, completed, in production, in QA, awaiting delivery, in
revision, delayed and on hold, plus the value of active projects and of
this month's orders, a by-department table (active projects, open slots,
in QA, approved, QA rounds and how many were sent back, and, for
management, throughput over the last 30 days and the on-time rate over the
last 90) and per-person workload. The Project Manager adds what is new in
the Project Closure Report and their own QA queue; Sales
gets what is waiting for the PM, what is ready to deliver and their
clients' value; a Team Lead sees their team only — projects routed to them
but not yet planned, their QA queue, revisions touching their team, their
members' workload; an Executive sees today's assignments (open work whose
planned start–end window includes today: an open-ended assignment that has
started counts, one starting tomorrow does not), active assignments and
current projects, slots pending / in QA / to redo / completed, revisions on
their work. Everyone gets the deadlines of the next seven days, each row
labelled project, assignment or revision and linking to that thing. Pricing
tiles exist only for roles that may see pricing.

### On hold and cancelled

Two statuses in §18 are decisions rather than the work's progress, and the
project page offers both to Sales, the Project Manager and management
(`projects.changeStatus`):

- **On hold.** The project remembers where it was (`held_from_status`).
  While it is held, nothing new can be assigned, uploaded, attached, opened
  as a revision or handed out from one. Work already in QA can still be
  signed off. Resuming puts it back
  where it was, then re-derives the status from the work, so a sign-off that
  landed during the hold is not lost.
- **Cancelled.** This is final and needs a reason. Every slot not yet
  approved, every open assignment and every open revision is withdrawn.
  Approved files stay in Sales' delivery queue, since what was finished can
  still be handed over, and a slot a withdrawn revision had sent back gets
  its delivered state back — a rework still waiting in QA goes with the
  revision, the file the client has stands, and Sales can mark it completed.
  Nothing is deleted.

Both notify the Sales owner, the PM, the team leads and whoever has work on
the project. Routing no longer resets a project that has started to
`planned`: re-saving triage on work in progress leaves its status alone, and
a held project stays held.

### Editing what was filed

Records are corrected in place, never filed twice (brief §27):

- **Project details.** Sales, the Project Manager and management open
  **Edit details** on a project to change what was filed: name, type,
  objective, description, PO, requirements, client notes and, for pricing
  roles, the price (`projects.edit`). Teams, quantities, priority, deadline
  and internal notes stay with triage. A completed or cancelled project, or
  one in a closed month, is read-only.
- **Who hears about it.** Sales and the PM are told which fields changed.
  The team leads and anyone with open work are told too, but a price change
  is never mentioned to them, and a change to the price alone does not
  reach them at all. The activity feed follows the same rule.
- **The client profile** (§31). **Edit client** changes the name, company,
  status, type, start date and notes. Only people who see every client may
  move a client to another Sales representative, because the owner is what
  scopes a rep's view. A rename onto another client's name is refused.
  Contacts can be edited or removed in place, and a client has at most one
  primary contact.

### Sharing a project with a colleague

A Sales rep sees their own clients' projects. To let a rep read one project
of someone else's client (§23 "authorized to view"), the Project Manager or
management shares it from the project page; the rep is told, and the share
can be withdrawn the same way. The rep then sees "Shared with you to view."
at the top of the project and can read everything — objective, PO,
requirements, the project's, assignments' and revisions' references, every
deliverable version, the workspace, the revisions themselves (the "Revision
#NN" links, `/revisions`, the revision page and the month report all list
them), the deliveries, the activity — and download the files, but every
control is gone: Edit details, hold and cancel, Attach files, "Add
references" on assignments, "Open a revision", the delivery moves, and on
the revision page Finish, "Attach reference files" and Delete; the comment
box on the project and on a revision says the thread is read-only. A share
never lets the rep delete a file either: file access has a read and a write
intent, deleting is the second, and the second never counts a share — so
even with the `delete_files` grant the Delete buttons are gone on a shared
project and `DELETE /api/files` answers 404 (logged as
`file.delete_denied`), while on their own projects the grant works as
before. The client's page opens
for them the same way, with its months, projects and reports readable and
Edit client, New project, Copy to next month, Create new month and
Close/Reopen month hidden. The server refuses each of those anyway; the page
matches it. Sharing and unsharing are lines in the project's activity, and
once unshared the project disappears for the rep again. Nothing here moves
the client: `view_all_clients` widens a rep's client list, sharing widens one
project.

### Previewing files

Every file link that can be viewed in place has a **Preview** button: in the
QA panel, the workspace, deliveries, revisions and attachments (§12, "open
file, review file"). Images and PDFs show inline, and video and audio play
in the page. Video uses range requests, so a Team Lead can scrub through a
large master without downloading it first.

Only formats that cannot run script are ever rendered: images other than
SVG, video, audio and PDF. The type is decided by the server from an
allowlist, never from what the uploader's browser declared. Everything else,
including SVG and HTML, is still a download (`src/lib/files/preview.ts`).
Viewing is permission-checked and logged exactly like a download.

### Downloading

Downloading is a right of its own (brief §43): who may keep a copy of a file
is decided apart from who may see it. Every staff role holds it by default;
an administrator withholds it from one account by ticking **Cannot download
files** under Restrictions on the user's page (`/admin/users/[id]`), which
stores a `no_download` row in `user_permissions`. That account keeps Preview
and inline viewing on every file it may see; its download links become plain
text, and `GET /api/files/:key` without `?inline=1` (or with it, on a file
that cannot be shown inline) answers 403 and logs `file.download_denied`
with `reason: download_withheld`. A file the account cannot see still
answers 404, as for everyone. CEO, COO and admin cannot be restricted.

This is the portal's control over what it offers, not DRM: a file that can be
viewed can still be saved from the browser's own player or PDF viewer.

### Time tracking and productivity (brief §29)

The first of the §29 future features, all working offline:

- **My time.** Anyone with assignments logs hours against their own work at
  `/time`. Nobody can log time for someone else. Entries can be dated up to
  31 days back and never in the future, and a day holds at most 24 hours.
  Closed months and cancelled projects take no time.
- **Estimates.** A Team Lead may give an assignment estimated hours when
  planning it. The workspace shows logged hours against the estimate, in red
  once over. It is shown to the assignee, their lead and managers only, not
  to colleagues.
- **Productivity.** `/reports/productivity` covers **team performance** and
  **employee productivity** for a month: hours, uploads, files approved,
  first-pass rate, on-time rate, how often work was sent back, and
  estimated against actual hours. Team Leads see their own teams, while the
  PM and management see every team.
- **Profitability.** For pricing roles, the same page lists the month's
  projects with price, estimated and logged hours, value per hour, cost and
  margin. Each hour is costed at its person's rate on the day it was worked.
  Hours by someone with no rate are flagged, because the cost leaves them
  out.
- **Cost rates.** The CEO and COO set each person's hourly cost, dated, on
  their user page (`costs.manage`). Rates live in their own table, so no
  ordinary user query carries them. A raise changes future hours only.
  Nobody else sees an individual rate, only project totals.

### Recurring projects

Sales ticks **Repeats every month** when filing or editing a project. A
nightly job (`npm run projects:recurring`, run by the `scheduler` service in
Docker) then copies it into each new month exactly as "Copy previous month"
would. The
copy gets a new code and lands in the Project Manager's intake, with the
deadline moved along and the flag carried over. The job acts as the
project's Sales owner, with their permissions. It is idempotent, and it
catches up a missed month from the newest copy — which may be one Sales made
by hand with "Copy to next month": the job continues from that copy rather
than copying the original again.

- **Paused or churned clients** are skipped quietly.
- **A departed owner or a closed month** is skipped, and the Project
  Managers are notified.
- **Clearing the flag** on the newest copy ends the chain.

### Sales pipeline

`/pipeline` tracks deals before they are confirmed, for Sales and management
(`pipeline.manage`). A deal belongs to a client from the start, and a new
name is added as a client with status **prospect**. Deals move through
Lead, Qualified, Proposal sent and Negotiation, and the page shows open
value and a forecast weighted by stage. Losing a deal needs a reason.

Winning is filing. **Won — file project** opens intake with the client,
title and price filled in. Filing marks the deal won in the same
transaction and links it to the project, and a prospect becomes an active
client dated from that day (§31). A deal that is closed, or that belongs to
another client, refuses the filing and nothing is created.

### The client portal (brief §29)

Client login, the client portal, client approval and rejection, and
automated client delivery:

- **Logins.** Sales, or management, gives people at a client access from
  the client page. Each login has a one-time password and belongs to exactly
  one client. A client login holds no capability at all. Every internal
  page and action sends it to `/portal`, and every API refuses it except
  file downloads, which apply the portal's own rule.
- **What clients see.** Their projects by month with progress, and the files
  delivered to them, with preview. They never see internal notes, comments,
  prices, teams or unfinished work. A file becomes visible only once it is
  delivered.
- **Approval.** Approving a file completes its delivery. **Request changes**
  records the client's words and tells Sales and the PM, who open the
  revision as usual (§15). Nothing is decided once the month is closed.
- **Automated delivery.** With auto-delivery switched on for a client, a file
  that clears final QA goes straight to the portal, provided the client has
  an active login. Clients are told when a file arrives, and can opt into
  email alerts.
- **Invoices.** Clients see their issued and paid invoices under Invoices,
  never drafts.

### Invoices (brief §29)

`/invoices` drafts invoices from each client-month's priced projects, so
nothing is re-typed. **Draft all** does every client for a month at once.
A project sits on one live invoice at most. Drafts can be edited: lines,
VAT, currency and a note.

**Issuing** numbers the invoice `INV-YYYY-NNNN` in the same transaction, so
numbers never skip, and freezes it. A wrong invoice is voided with a reason,
which makes its projects billable again while the number stays used.
Invoices can be marked paid. The print view saves to PDF from any browser,
offline. The CEO and COO set company details, TRN, default VAT (5%), terms
and bank details under Billing settings. Amounts are worked in whole fils.

### Email, Slack and WhatsApp (brief §29, §46)

Optional copies of inbox notifications. Each channel is off until it is
configured in `.env`, and each person opts in from the inbox settings.
The `notifier` service sends, retries with backoff, and never replays old
notifications. See docs/runbook.md.

### Forecasts, suggestions and AI summaries (brief §29)

- **Deadline prediction.** This needs no network. Each team's pace over the
  last 30 days, and its queue served earliest deadline first, give a finish
  date per team and per project. The project page shows it with the
  reasoning. The dashboard lists projects forecast to miss their deadline.
  With too little history it says so rather than guessing.
- **Assignment suggestions.** This needs no network either. The planning
  board ranks the team by open work, first-pass and on-time record over 90
  days, and past work for the client. It gives the reasons and preselects
  the top pick, and the lead still chooses.
- **AI project summaries.** These are optional, via Claude. The feature is
  off unless `ANTHROPIC_API_KEY` is set, and runs only when someone clicks
  it. It is the one feature that sends project data outside the building,
  and the page says so. Each summary is written from what its audience may
  see: price and internal notes for pricing roles only. Summaries are
  stored, so reading one costs nothing.

### Mobile

The portal installs as an app from the browser, using "Add to Home Screen".
A manifest and generated icons are provided, and the navigation folds into a
menu at phone width. It is still served from the office server, with no app
store involved.

### Attachments and file deletion

Reference files hang off exactly one parent, and each parent has its own
rule for who may add to it:

| Parent | Brief | Who may attach |
|---|---|---|
| the project | §3 (brief, references) | anyone who can see the project as their own — not a rep it is only shared with |
| the project, as its PO document (kind `po`) | §3 (PO) | Sales or the Project Manager (`projects.edit`); never on an assignment or revision, which the database also refuses |
| one assignment | §7 (references) | its assignee, its team's lead, the PM |
| one revision | §15 (client's markup) | anyone the revision is visible to (`revisionScope`) as their own — not a rep its project is only shared with |

They go through the same resumable upload as deliverables (the session
records the parent), and are readable exactly when their project is.
Revision attachments are also listed only to people who can see that
revision. The project page lists the references, and shows the PO document
in the PO block beside the PO reference; the assignment's references sit on
its row in the workspace, and the revision page has its own. The intake,
assignment and revision forms take files directly and attach them as the
record is created — the intake form with a separate "PO document" input,
sent as kind `po` — and each attachment remembers what it is for: "PO /
brief" from intake's brief box, a reference from the assignment form,
"client reference" from the revision form, "PO" for the PO document — shown
as a small tag beside the filename. The upload session carries the kind, and
completion re-checks the PO rule, so a session opened as a reference cannot
land as the PO. If the record is
created but one of its files fails to attach, the form stays finished — the
button reads "Filed" (or "Opened") and is disabled, the "Attaching 2/3"
progress is cleared — and a red line names the file and leads to the
project to attach the rest, since filing again would make a second record;
the assignment form recovers and shows its error the same way. The Attach
buttons follow the server's rule exactly (`mayAttachToProject`, the pure
half of `canAttachToProject`, with a test walking every project status):
hidden when the project is on hold, cancelled or completed, when its month
is closed, or when it is only shared with the rep — and the server refuses
those uploads as well as the page hiding the button (§18). An upload is
checked again when it completes: one started before the project was held,
before the assignment was handed to a colleague, or before the rep lost the
project is refused at that point — nothing is recorded, and the bytes
already sent are kept, so the same upload completes without re-sending once
the right is back.

Holders of `files.delete` (management, admin, or a per-user grant) get a
**Delete** button on versions and attachments (§43) — on the projects that
are theirs, never on one only shared with them to read (above). Deletion is
soft: the
file is struck through for them and gone for everyone else, and the bytes
stay until the retention sweep.

### Reports and team overview

`/reports` is the PM's Reports section (§5) and the §39 monthly report.
Pick a month to see every client with work in it: projects, deliverables,
completed, ready to deliver, in QA, in revision and pending. Each
deliverable is counted in exactly one column, so the columns add up to the
total. It also has a by-team table and, for pricing roles only, order value.
Opening a client (or **Report** on a month of the client page) gives the
§33 view of that month: the per-project table with a Comments column (the
count, linking to the thread on the project), final approved files with
download links, revisions, the people involved, delivery dates, and at the
foot the month's complete activity — everything that happened on its
projects and to the month itself (opened, closed, reopened, copied into —
a month the demo data opens by hand carries the same "opened" line), in
order, with price changes shown only to people who see pricing (§36). Every
figure is scoped like every list, and a client's month line on the client
page and that month's report give the same numbers to the same person.
**Export CSV** needs `reports.export`, is logged, and guards against
spreadsheet formula injection.

`/teams` is Team Overview (§5, §6): each production team, its leads and
members, per-person workload, and the team's active projects with dates.
The PM and management see every team; a Team Lead sees only their own.

### Backups

A `backup` service in Compose runs nightly (§44). It takes a verified
`pg_dump`, then a restic snapshot of the file store and the dumps to a
second location. A weekly rehearsal restores the latest dump into a
scratch database and compares row counts. Restore scripts for the database
and files, a full-rebuild procedure and the honest RPO/RTO are in
docs/runbook.md.

File backups are mandatory (§44). A run with no `RESTIC_REPOSITORY` still
dumps the database but fails, `npm start` refuses to run without one unless
`BACKUP_FILES_DISABLED=1` is set on purpose (database dumps only), and the
Compose fallback directory `./backups/restic-NOT-OFFSITE` is on the server's
own disk, so it is never a backup.

The management dashboard (and `/api/health`) reports whether backups are
working:
- **failed:** the last run failed
- **unconfigured:** `RESTIC_REPOSITORY` is not set — the run fails and the
  uploaded files are not backed up anywhere
- **warning:** the repository is on the same disk, nothing complete for 36
  hours, or the rehearsal failed or is more than a week old
- **disabled:** `BACKUP_FILES_DISABLED=1` — database dumps only, explicitly
- **unknown:** nothing has run yet

It is read from the status files the backup job writes, mounted read-only
into the app.

`/api/health` also carries a `jobs` block — the last run of the retention
sweep, the recurring projects and the nightly housekeeping, with `stale:
true` after 36 hours or when a job has never run — and the same dashboards
show a banner when any job is stale or failed. In Docker the `scheduler`
service runs the three on a schedule; each run is recorded under
`STORAGE_ROOT/jobs` (docs/runbook.md, "Scheduled jobs").

### Activity

Each project page ends with the §25 feed: who did what, in order, in one line
each — "leadVideo rejected Video 01 v1", "pm approved Video 01 v2", "sales
delivered Video 01 to the client", "sales opened revision #01", "pm shared
the project with Sam Rep", "Video 01 was delivered to the client portal
automatically", "Client approved Video 01", "September 2026 was archived
automatically". A QA decision is written by the system at the moment it is
made, ahead of what it sets off, so an approval always reads before the
automatic portal delivery it triggered. The wording is a pure function over
the `activity_log` row (`src/lib/activity/describe.ts`), so it is tested
without a database. Downloads and refused attempts stay in the log for an
administrator's query; they are not shown on the page. Each row carries the
request's address from the first `X-Forwarded-For` hop as the `inet` column
takes it — a port is stripped, an IPv6 zone id ("fe80::1%lo0") dropped, and
"unknown" or anything else the column would refuse stored as no address — and
the session record at login follows the same rule, so a hop the column would
refuse never fails the action or the login.

### The policy layer

`src/lib/authz` is the only place a role check may live.

| Export | Use |
|---|---|
| `can(actor, action)` | capability check, on a loaded resource |
| `projectScope(actor)` / `clientScope(actor)` | a `WHERE` fragment **every** list query must compose |
| `stripRestrictedFields(actor, row)` | removes pricing server-side for users without `view_pricing` |

`projectScope`/`clientScope` take the table alias the surrounding query uses
(`projectScope(actor, 'p')` for `FROM projects p`), because an alias shadows
the table name.

No route may hand-roll a role check. That is how brief §22 — "an Executive
should not be able to search and discover projects they don't have access to" —
stays true once search arrives.

Row visibility is proven by `tests/policy.test.ts`, which asserts both
directions (what each role sees, and what it must not) for all six roles
against a real PostgreSQL.

### Files

Bytes never leave the server except through `GET /api/files/:storageKey`,
which checks policy and writes an audit row. There is no static route to the
file store, so browsing a network share is not an alternative path to the same
data (brief §43). A file is readable exactly when its **project** is — which
is what makes the shared workspace of §10 work without widening access. On a
plain install, `npm run setup` creates the store (`STORAGE_ROOT`) readable by
the account running the portal only, and tightens an existing looser folder
the next time it runs; docs/runbook.md ("The file store without Docker")
says where to keep it on a shared machine.

On disk the store follows the brief's §42 hierarchy, by ids rather than by
names: `files/clients/<client>/<YYYY-MM>/projects/<project>/deliverables/<slot>/v<n>/`
for versions and `…/projects/<project>/attachments/` for references, with a
UUID as the leaf, so nothing typed by a user ever becomes a path. A download
is saved under its real name with the version and the project code in front
— `AKT-2026-0001_Video_Final_v2.mp4` for a version,
`AKT-2026-0001_PO-4411.pdf` for an attachment — so a file on someone's desk
can be traced back (§19, §24); a name that already carries the code is not
prefixed twice.

Uploads are resumable, because this is a video agency and a single POST of a
4 GB master will not survive office Wi-Fi:

| Step | Request |
|---|---|
| Open | `POST /api/uploads` → `{ uploadId, offset, chunkSize }` |
| Resume | `HEAD /api/uploads/:id` → `Upload-Offset` |
| Send | `PATCH /api/uploads/:id` with `Upload-Offset`, body = chunk |
| Finish | `POST /api/uploads/:id/complete` |
| Abandon | `DELETE /api/uploads/:id` |

Chunks are written **positionally** at the offset the server recorded, so a
retry after a failed request rewrites exactly those bytes rather than
duplicating them. Any failed chunk rolls the staging file back to the recorded
offset, so on-disk length always equals `bytes_received` and the client can
trust the offset it is given. The finished file is moved into place with a
same-filesystem rename, so a half-written file can never appear at its final
path. SHA-256 is computed server-side and compared against the client's
declared checksum when one is supplied.

Uploading to a deliverable creates a **new version of that slot**, never a new
slot, and returns it to the Team Lead's QA queue (brief §7, §11, §19).

Deletes are soft. `npm run files:sweep` removes the bytes once the retention
window has passed and clears abandoned uploads; the `scheduler` service runs
it nightly before the backup, and without Docker you schedule it
(docs/runbook.md, "Scheduled jobs").

## Local development

```bash
cp .env.example .env          # then point DATABASE_URL at your database
npm install
npm run db:migrate            # applies drizzle/*.sql
npm run db:seed               # needs ADMIN_EMAIL and ADMIN_PASSWORD
npm run dev
```

## Deployment

See `docs/runbook.md`. In short:

```bash
docker compose up -d --build
docker compose --profile seed run --rm seed
```

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build (standalone output) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Schema drift, migration integrity, capability matrix, and — when `DATABASE_URL` is set — the row-visibility matrix |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Create the first administrator |
| `npm run setup` | One-command local setup: `.env`, database, migrations, demo data, and a file store readable by this account only; ends with what backups still need |
| `npm start` | Production server. Its pre-flight refuses to start without `RESTIC_REPOSITORY` unless `BACKUP_FILES_DISABLED=1` is set on purpose (§44); `npm run dev` only warns |
| `npm run files:sweep` | Purge soft-deleted files past retention, clear stale uploads. In Docker the `scheduler` service runs it nightly before the backup |
| `npm run projects:recurring` | File this month's copy of every recurring project; `-- --dry-run` lists what is due. In Docker the `scheduler` service runs it nightly |
| `npm run jobs:nightly` | Stored deadline reminders and the automatic month archive; `-- --dry-run` lists the months it would close. In Docker the `scheduler` service runs it nightly after the recurring run and before the backup; without Docker, the cron lines are in docs/runbook.md, "Scheduled jobs" |
| `docker compose run --rm scheduler nightly-now` | Run tonight's housekeeping now (also `sweep-now`, `recurring-now`; each accepts `--dry-run`) |
| `docker compose run --rm backup backup-now` | Take a backup now (see docs/runbook.md) |
| `docker compose run --rm backup verify-now` | Run the restore rehearsal now |

## How the schema is maintained

`drizzle/0001_init.sql` is the source of truth. `src/db/schema.ts` is a
hand-written Drizzle mirror used for typed queries only — constraints, indexes
and checks live in SQL. `npm test` parses the SQL with the real PostgreSQL
grammar and fails if the two drift apart in either direction, so the mirror
cannot silently rot.

Schema changes: add a new numbered migration under `drizzle/`, update the
mirror, run `npm test`. Every migration is parsed, not just the first.
