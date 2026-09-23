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

## Current state: Phase 1a complete (M0–M7)

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

Phase 1b (revisions, copy-month, search, notifications, dashboards) is next.

### Clients, months and intake

`Client → Month → Project` is the spine (brief §34, §47), and it is enforced
rather than encouraged:

- **The client is chosen, never typed.** The intake form offers a select of
  clients the filer can see, plus a link to create the record first. A unique
  index on `lower(name)` refuses a case-variant duplicate, which is what keeps
  a client's years of history attached to one profile.
- **Filing a project opens its month.** Two projects filed for the same client
  and period land in one bucket; a concurrent race settles on one rather than
  creating two. "Open next month" exists for planning ahead (§37) and never
  re-asks for client details.
- **Project codes** are `AKT-YYYY-NNNN`, issued by a counter that takes the
  greater of its own next value and the highest code that actually exists — so
  a restored database or a hand-inserted row corrects itself instead of
  colliding.
- **Deliverable counts are per team.** One project can need Video and Design
  with different quantities (§10), which is what M5 turns into slots.

Pricing is accepted only from someone allowed to see it, so a replayed form
cannot set a price its sender was never shown.

### Routing (PM triage)

`/triage` is the Project Manager's intake queue — what the brief calls the
**Project Closure Report** (§4, §5), though it holds newly filed projects
awaiting routing rather than closures. The heading says both.

Routing happens inline on the project page, so the objective, PO and
requirements sit directly above the decision. A Team Lead is assigned **per
department**, not per project:

- A lead can only be given a team they actually lead — otherwise QA would show
  them deliverables they have no standing to judge.
- Routing every team moves the project to `planned`; routing some of them
  leaves it `awaiting_assignment` and in the queue, so partial work looks
  unfinished rather than scheduled.
- A team can be added during triage, and removed only while it has no work.

`/planning` shows a Team Lead the rows for the teams they lead — and nothing
from any other team, on the same project.

### Planning and assignment

Opening a row reaches that team's board: what Sales promised, what has actually
been planned, the team's workload, and the assignments already made.

Assigning work **opens all of its deliverable slots in one action** — twenty
designs is one decision, not twenty forms. Slots are numbered per team and
continue from what exists, so a second assignment starts where the first
stopped and numbers never collide. A slot is the unit of progress; files attach
to it as versions (§11, §19).

Guardrails: work can only be given to a member of that team, only by that
team's lead or the Project Manager, and a refused assignment leaves no orphan
slots behind.

**Workload** means open deliverable slots — those not yet approved — plus how
many are in QA and how many are due within a week. It is committed work, not an
estimate of hours; there is no time tracking in Phase 1.

### The executive workspace

`/work` is an Executive's landing page (brief §8): the assignments they hold,
split into **current** and **previous**. Either side closing moves a row to
previous — a finished assignment, or a project that was completed or cancelled
under it — so history stays reachable without cluttering the desk.

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
`planned` — to `in_progress` (§18). Comments attach to the project or to one
slot and are visible to anyone who can see the project; nothing can be said
about a slot the author cannot see.

### QA

`/qa` is one page with two audiences (§12, §13). A Team Lead sees the slots in
their teams that are `awaiting_lead_qa`; a Project Manager sees the slots
everywhere that are `awaiting_pm_qa`. The stage is read from the slot, never
chosen by the reviewer, so a lead cannot sign off at the PM stage and a
designer's lead cannot judge a video.

Three decisions, one comment box. **Approve** passes the slot to the PM if
that team requires PM QA, otherwise straight to `approved` and into Sales'
delivery queue. **Request changes** and **Reject** both return it to the
Executive as `changes_requested`, with the comment shown on their slot. A
re-upload after that is a new version of the same slot, so a deliverable
rejected twice still counts as one — the number nobody sees move is the point.

Every round is appended to `qa_reviews`; nothing is overwritten. Whether a team
needs PM QA is per team (`project_departments.requires_pm_qa`), seeded from
the project at intake, and silence from the PM at triage leaves it alone.

### Deliveries

`/deliveries` is Sales → Deliveries (§14): each approved file with its version,
who approved it and what they said, and the five statuses in the brief.
Transitions are ordered — a file cannot be `completed` before it has been
`delivered` — and marking it delivered records who and when. The portal does
not send the file; it records that a person did.

Project status follows the work from here (§18, §26): every slot approved →
`ready_for_delivery`; every slot delivered → `delivered`; every delivery
completed → `completed`, with `completed_at` set. An assignment closes when its
last slot is signed off.

### Activity

Each project page ends with the §25 feed: who did what, in order, in one line
each — "leadVideo rejected Video 01 v1", "pm approved Video 01 v2", "sales
delivered Video 01 to the client". The wording is a pure function over the
`activity_log` row (`src/lib/activity/describe.ts`), so it is tested without a
database. Downloads and refused attempts stay in the log for an administrator's
query; they are not shown on the page.

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
is what makes the shared workspace of §10 work without widening access.

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
window has passed and clears abandoned uploads; run it nightly beside the
backups.

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
| `npm run files:sweep` | Purge soft-deleted files past retention, clear stale uploads |

## How the schema is maintained

`drizzle/0001_init.sql` is the source of truth. `src/db/schema.ts` is a
hand-written Drizzle mirror used for typed queries only — constraints, indexes
and checks live in SQL. `npm test` parses the SQL with the real PostgreSQL
grammar and fails if the two drift apart in either direction, so the mirror
cannot silently rot.

Schema changes: add a new numbered migration under `drizzle/`, update the
mirror, run `npm test`. Every migration is parsed, not just the first.
