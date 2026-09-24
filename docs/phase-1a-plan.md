# Phase 1a — The Spine

**Goal:** one project travels the full path — Sales creates it → PM triages and assigns → Team Lead plans and assigns an Executive → Executive uploads → Team Lead QA → (optional PM QA) → Sales marks delivered — on the local server, with permissions enforced and every action logged.

Phase 1a deliberately does **not** include revisions, copy-month, search, or notifications. Those are Phase 1b. What 1a must get right is the spine, because everything in 1b hangs off it and none of it is retrofittable.

---

## Scope

**In**
- Auth, sessions, roles, user + department admin
- Clients, client contacts, monthly buckets (auto-created, manual "Create next month")
- Project intake by Sales, with `AKT-YYYY-NNNN` code allocation
- PM triage queue → assign department(s) + Team Lead per department
- Team Lead planning board → create assignments + deliverable slots
- Executive project list + project view + versioned upload
- Team Lead QA queue → approve / request changes, with QA rounds recorded
- Optional PM QA stage, per project
- Sales delivery queue with the five §14 statuses
- Activity log on every state change and every file read/write
- Shared project workspace (multi-department file visibility, §10)

**Explicitly out (Phase 1b)**
- Revisions (tables are in the schema; UI and workflow are 1b)
- Copy-previous-month, monthly archive close/reopen, monthly reporting
- Global search + filters
- In-app notifications and deadline reminders
- Dashboards beyond a minimal "my work" landing page per role

**Out of Phase 1 entirely** — everything in brief §29.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js (App Router), Node 24 | One deployable serving UI + API; server components keep permission checks server-side by default |
| DB | PostgreSQL 17 | Composite FKs, partial indexes, `pg_trgm` for 1b search — all used by the model |
| ORM | Drizzle | Thin over SQL; `drizzle/0001_init.sql` stays the source of truth, Drizzle schema mirrors it |
| Auth | Own session table + argon2id | No internet, no external IdP. Sessions in Postgres, httpOnly cookie |
| Jobs | Worker process (BullMQ + Redis, or `pg_cron`) | Needed in 1b for deadline reminders and nightly backups; stub it in 1a |
| Deploy | Docker Compose on the internal server | `app`, `worker`, `postgres`, `caddy`. One `docker compose up -d` |
| TLS | Caddy with an internal CA | LAN hostname `https://portal.aktivacity.local` — a secure context, not raw HTTP |

**Note:** this is on-premise by requirement (brief §40–46). No cloud hosting, no managed database, no external services in the critical path.

---

## Two things built before any feature

Both are cross-cutting. Retrofitting either means a rewrite, which is why they are M1 and M2 rather than "we'll add it later".

### 1. The policy layer

A single module — `lib/authz` — exposing two things and nothing else:

```ts
can(user, action, resource): boolean          // yes/no on a loaded resource
scope(user, 'project'): SQL                   // a WHERE fragment every list query must use
```

Every list query composes `scope()`. Every mutation calls `can()`. No route hand-rolls a role check — that is how §22's "an Executive should not be able to search and discover projects they don't have access to" quietly breaks.

Scoping rules:

| Role | Sees |
|---|---|
| CEO / COO / Admin | Everything |
| Sales | Projects for clients they own, plus projects they created |
| Project Manager | Everything, all departments (§6) |
| Team Lead | Projects with a `project_departments` row for a department they lead |
| Executive | Projects with an `assignments` row for them — **plus** the shared workspace of those projects (§10) |

Pricing is a **field-level** rule, not a row-level one: `price_amount` is stripped in the serializer unless the user holds `view_pricing` (role-derived for CEO/COO/Admin/Sales/PM, or granted per-user via `user_permissions` for the §23 exception). Strip it server-side — never send it and hide it in CSS.

**Acceptance:** a test suite that, for each of the six roles, asserts both directions — the rows they must see and the rows they must not. This suite is the regression net for the whole project.

### 2. The file layer

- Files land under `STORAGE_ROOT`, **outside the web root**, named by `files.storage_key` (a UUID), never by the user's filename. Logical path stored in `files.storage_path` as `client/<id>/<year>/<month>/project/<id>/deliverable/<id>/v<n>`, which mirrors §42 without ever trusting user input in a path.
- **Every** download goes through `GET /api/files/:storage_key` → `can()` → stream → write an `activity_log` row. There is no static file route. This is the whole of §43.
- **Resumable chunked uploads** from day one. This is a video agency: a 4 GB master over office Wi-Fi will not survive a single POST. Use tus or a chunk endpoint writing to a temp dir, then atomically rename into place and insert the `files` row in the same transaction as `deliverable_versions`.
- Checksum on upload (`sha256`), stored, and used to detect duplicate re-uploads.
- Delete is soft (`files.deleted_at`) and gated on the `delete_files` permission. Bytes are swept by a job only after a retention window.

**Acceptance:** an Executive in Design cannot fetch a Video deliverable's file by guessing or replaying a URL; the attempt appears in `activity_log`.

---

## Milestones

Sequential. Each one ends in something demonstrable on the server.

**M0 — Infrastructure (3–4 d) — DONE**
Docker Compose up; Postgres with `drizzle/0001_init.sql` applied as migration `0001`; Drizzle schema mirroring it; Caddy serving the LAN hostname over TLS; seed script for departments and an admin user; CI running typecheck + tests.
*Done when:* a teammate on the office network loads the login page over `https://`.

**M1 — Auth, roles, users (4–5 d) — DONE**
Login/logout, argon2id, session cookies, forced first-password change, deactivation. Admin screens for users, department membership, and per-user permission grants. The `lib/authz` module and its full test matrix.
*Done when:* the policy test suite is green for all six roles.

**M2 — File layer (4–5 d) — DONE**
Chunked upload, gated streaming download, checksums, soft delete, audit rows on every read and write.
*Done when:* a 2 GB file uploads over Wi-Fi with a mid-upload network drop and resumes.

**M3 — Clients, months, project intake (5–6 d) — DONE**
Client profiles + contacts + services. Month buckets auto-created on first project of a period, plus explicit "Create next month". Sales project form (all §3 fields), with client as a **searchable select that can create a new client inline — never a free-text field**. `AKT-YYYY-NNNN` allocated transactionally via `project_code_sequence`.
*Done when:* two projects filed for the same client in the same month land in one bucket, and a near-duplicate client name is refused.

**M4 — PM triage (3–4 d) — DONE**
The queue currently called "Project Closure Report" in the brief (see Open Questions). Shows `status = 'new'`. PM opens a project, reads objective/PO/requirements/pricing, sets priority and deadline, adds internal notes, and selects **one or more departments**, assigning a Team Lead to each. Project moves to `awaiting_assignment` → `planned`.
*Done when:* a project assigned to Video + Design appears in both Team Leads' queues and neither can see the other's department rows.

**M5 — Team Lead planning and assignment (5–6 d) — DONE**
Per-department planning view: team members, their current assignments, workload as a count of open deliverables in the date window. Create an assignment (§7 fields) and generate N deliverable slots in one action — bulk creation is mandatory, "20 social designs" is a normal order.
*Done when:* one action creates an assignment with 20 slots, and the Team Lead sees `0/20`.

**M6 — Executive workspace (5–6 d) — DONE**
Current Projects / Previous Projects. Project view showing objective, PO, requirements, instructions, own deliverables, deadline, **other departments' members and their uploaded files** (§10), and comments. Upload against a slot → creates `deliverable_versions` v1, flips the slot to `awaiting_lead_qa`, marks previous versions `is_current = false`.
*Done when:* a Video Executive sees the Design Executive's thumbnails on the shared project but cannot see that project's pricing.

**M7 — QA and delivery (5–6 d) — DONE**
Team Lead QA queue over `awaiting_lead_qa`. Approve → `awaiting_pm_qa` if `requires_pm_qa`, else `approved` plus a `deliveries` row. Request changes → `changes_requested`, Executive uploads v2 (a new version, **not** a new slot, so progress does not double-count). PM QA queue with the same shape; a PM rejection returns the slot to the Executive with the Team Lead notified. Sales delivery queue with the five §14 statuses.
*Done when:* the §25 activity log for a project reads end to end like the example in the brief, and a deliverable rejected twice still counts as one slot.

---

## Progress semantics (the §7/§11 ambiguity, resolved)

The counter shown everywhere is **approved slots / total slots**. A rejection-and-reupload cycle produces v2 on the same slot and does not move the number. Team Lead and PM views additionally show `uploaded` and `in_qa` from `v_assignment_progress` so a lead can distinguish "nothing has arrived" from "five are sitting in my queue".

Confirm this with the client before M5 — §7's example reads as upload-based counting, which would show `2/2` on work that has not been reviewed.

The Executive's own list shows `approved/total` too, with "N in QA" or "N to redo" beneath it, so the number they see is the number their lead sees. The first upload on an assignment also moves it, and a `planned` project, to `in_progress` (§18) — status follows work arriving, not a button.

---

## Deployment and backup

- `docker compose up -d` on the internal server; images built in CI, or on the box if it has no network.
- **Nightly** `pg_dump --format=custom` + continuous WAL archiving to a second location.
- **Nightly** `restic` snapshot of `STORAGE_ROOT` to the NAS/secondary machine, with retention.
- A `docs/runbook.md` covering restore from dump, restore from WAL, file restore, and full server rebuild — with a **rehearsed** restore, not just a written one. Brief §45 asks for documented procedures; an unrehearsed procedure is a guess.
- State the RPO/RTO plainly: with nightly dumps plus WAL, RPO is minutes and RTO is however long a rebuild takes. There is no HA — one server, by design (§40).

---

## Phase 1a status

All seven milestones are built and their acceptance criteria are covered by
`npm test` against a real PostgreSQL (the suite reports `skipped 0` when
`DATABASE_URL` is set). The open questions below were resolved by design where
they blocked a milestone; each is a small change if the client answers
differently.

## Phase 1b progress

- **Revisions (§15–17) — DONE.** `revisionScope` in `lib/authz`, create / hand
  off / close in `lib/revisions`, status derived from the slots, `/revisions`
  pages, upload tagging, and the delivery panel's "open a revision" link.
  Covered by `tests/revisions.test.ts`.
- **Monthly archive (§33, §36–§39) — DONE.** `lib/months`: close (refused
  while any project is unsettled), reopen (separate capability), the
  `assertMonthOpen` guard called by every mutation module, copy-previous-month
  as one transaction with `copied_from_project_id` lineage, and per-month
  summaries on the client page. Covered by `tests/months.test.ts`.
- **Global search + filters (§22) — DONE.** `lib/search`, `/search`, header
  search box. Covered by `tests/search.test.ts`, including the brief's own
  acceptance example.
- **Notifications (§20) — DONE.** `lib/notifications`: events emitted inside
  each mutation's transaction, the inbox with mark-read, live deadline
  reminders. Covered by `tests/notifications.test.ts`.
- **Per-role dashboards (§21) — DONE.** `lib/dashboard`, one scoped loader,
  one page shaped by role. Covered by `tests/dashboard.test.ts`.

Phase 1b is complete. What remains for Phase 1 is confirmation of the open
questions below and the deployment work in docs/runbook.md on the real
server.

## Open questions — blocking

1. **Progress counting** — approved or uploaded? (blocks M5/M7; see above) — *Built as approved/total, with uploaded and in-QA counts shown beside it. Confirm.*
2. **"Project Closure Report"** — the brief uses this name for the *new project intake* queue. Keep the name, or rename to something like "Project Intake"? (blocks M4 UI copy and route naming)
3. ~~**Sales visibility**~~ — **resolved by design, confirm when convenient.** Sales is scoped to their own clients by default; the existing `view_all_clients` grant widens an individual rep to everything, so either answer is a permission toggle rather than a code change.
4. **File volume** — expected GB/month, and the server's current disk, RAM, CPU? (blocks M0 sizing and the backup target decision)
5. **Backup hardware** — is a second machine or NAS available, or does one need buying? (blocks M0)
6. **Currency** — schema defaults to AED. Confirm, and confirm whether multi-currency is ever needed.

## Open questions — non-blocking, needed before 1b

7. ~~Who closes a month, and can a month close with open deliverables?~~ —
   **resolved by design, confirm.** Sales and the PM close (`month.close`);
   management and admin reopen (`month.reopen`). A month closes only when
   every project in it is completed or cancelled — the refusal names the
   ones still open. If closing with open work is wanted, it is a flag on
   `closeMonth`, not a redesign.
8. How is a project spanning two months attributed — month of creation, or month of delivery?
9. Is pricing per project only, or is there also a monthly retainer figure per client-month?
10. User count and peak concurrent uploads?
11. **Workload definition.** The planning board defines workload as a count of
    open deliverable slots (plus how many sit in QA and how many are due within
    a week). It is committed work, not hours. If capacity in hours is wanted,
    an estimate field on the assignment is the smallest change that gets there.

---

## Sizing

Roughly **6–8 weeks for one full-stack developer**, assuming the six blocking questions are answered before M3 and the server exists at M0. M2 and M7 carry the most risk — large-file handling and the QA state machine respectively. Phase 1b (revisions, search, notifications, archive, dashboards) is a comparable block of work on top.
