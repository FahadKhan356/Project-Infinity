export const meta = {
  name: 'aktivacity-audit-seed-local',
  description: 'Audit brief vs implementation, build realistic demo seed, make local run turnkey',
  phases: [
    { title: 'Audit', detail: 'one auditor per brief-section cluster' },
    { title: 'Verify gaps', detail: 'adversarial check of every claimed gap' },
    { title: 'Seed', detail: 'realistic demo seed through the domain layer' },
    { title: 'Local run', detail: 'env loading, setup script, local Postgres helper, telemetry, npm start' },
  ],
}

const REPO = '/Users/succ/Desktop/ProjectInfinity'
const SCRATCH = '/private/tmp/claude-501/-Users-succ-Desktop-ProjectInfinity/6aa80cad-0adf-4262-87f2-d5c136005bc6/scratchpad'
const BRIEF = `${SCRATCH}/brief.md`

const ENV_FACTS = `
Environment facts (macOS, this machine):
- Repo: ${REPO}. Next.js 16.3 App Router + React 19 + drizzle over postgres.js + PostgreSQL. Read AGENTS.md: this Next version differs from your training data; docs are in node_modules/next/dist/docs/.
- The working tree has a LOT of uncommitted work that belongs to the user. Never run git checkout/reset/stash/clean, never revert files you did not create, never commit.
- PostgreSQL 17 (Homebrew, not a brew service) is RUNNING on localhost:54329, trust auth, superuser role "aktivacity". Binaries: /opt/homebrew/opt/postgresql@17/bin (psql, createdb, dropdb, initdb, pg_ctl).
  Databases: aktivacity_test (used by \`npm test\`; do NOT seed into it or drop it), aktivacity_dev (empty, for the demo seed).
- Server modules import 'server-only', so any script that imports src/lib/** must run as: node --conditions=react-server --import tsx <script>  (see scripts/run-recurring.ts and the "projects:recurring" npm script).
- ffmpeg/ffprobe are at /opt/homebrew/bin (available on THIS machine only, not on the user's target machine).
- The brief text is at ${BRIEF}. The README (31 KB) documents every implemented feature; drizzle/0001_init.sql..0013_*.sql is the schema source of truth; src/lib/authz is the policy layer.
`

// ---------------------------------------------------------------- audit --
const CLUSTERS = [
  { key: 'auth-roles-permissions', sections: '§2 User Roles, §3 "Pricing Visibility", §23 Permissions, §28 "Authentication & Roles" (login, role-based access, user management)' },
  { key: 'sales-intake-pm', sections: '§3 Sales Portal / Project Creation (every listed field incl. attachments, pricing, number of deliverables, department/team required), §4 Project Creation Flow, §5 Project Manager Portal (all main sections + everything the PM can do in the Project Closure Report), §24 Project ID, §27 single Project record' },
  { key: 'planning-assignment-progress', sections: '§6 Planning System (PM planning: all teams, leads, members, projects, workload, start/end dates, deliverables, status; TL planning scoped), §7 Assigning Work (every assignment field incl. attachments/references and priority; automatic progress 0/2→1/2→2/2), §11 Deliverable Progress' },
  { key: 'executive-workspace-files', sections: '§8 Executive Portal (Current Projects fields list, Ongoing/Previous Projects), §9 Executive Project View (every see/can item), §10 Shared Project Workspace (file name, uploaded by, date/time, version, comments, status), §19 File Versioning' },
  { key: 'qa-delivery', sections: '§12 Team Lead QA Panel (open, review, approve, reject, request changes, QA comments, forward approved), §13 Project Manager QA (configurable per project), §14 Sales Delivery Panel (every column and the five delivery statuses)' },
  { key: 'revisions-statuses', sections: '§15 Revision System (every field incl. attachments/comments), §16 Revision Visibility, §17 Revision Workflow, §18 Project Status (all 12 statuses reachable and meaningful)' },
  { key: 'notifications-dashboards-search-activity', sections: '§20 Notifications (every example event per role, incl. "Project delayed" and "Deadline approaching"), §21 Dashboard (every tile listed for Management, PM, TL, Executive), §22 Search & Filters (every search dimension; permissions apply), §25 Activity / Audit Log' },
  { key: 'clients-months-archive', sections: '§31 Client History & Repeat Clients (every profile field), §32 Monthly Project Structure, §33 Previous Month History (everything visible when opening a past month), §34 hierarchy, §35 Client Overview Page (current month table: Project/Team/Status/Progress, active/completed/total months counters, View Previous Months), §36 Monthly Archive (read-only, reopen), §37 New Month Creation, §38 Copy Previous Month, §39 Monthly Reporting, §47 architecture, §48 long-term objective (search a client and understand everything)' },
  { key: 'local-infra-backup-offline', sections: '§40 Local Server Architecture, §41 Browser-Based, §42 Local File Storage (Client → Month → Project → Deliverable → Version logical structure), §43 File Access Permissions (view/upload/delete/download/approve), §44 Local Server Backup, §45 Server Failure Consideration (documented frequency, location, DB restore, file restore, server recovery), §46 Internet Dependency (core works offline; integrations optional). Also check: does anything in the default configuration make outbound network calls (fonts, CDNs, analytics, telemetry, APIs)?' },
]

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'brief section and bullet, e.g. "§7 Attachments/references"' },
          requirement: { type: 'string' },
          status: { type: 'string', enum: ['implemented', 'partial', 'missing'] },
          evidence: { type: 'string', description: 'file:line references (route + lib) proving the status' },
          gap: { type: 'string', description: 'for partial/missing: the concrete, user-visible gap and where a fix would go; empty when implemented' },
        },
        required: ['ref', 'requirement', 'status', 'evidence', 'gap'],
      },
    },
  },
  required: ['requirements'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true if the gap is NOT real (already implemented, or not actually required)' },
    reasoning: { type: 'string' },
    evidence: { type: 'string', description: 'file:line references' },
    fixSketch: { type: 'string', description: 'if the gap is real: smallest correct fix, files to touch, tests to add' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['refuted', 'reasoning', 'evidence', 'fixSketch', 'severity'],
}

function auditPrompt(c) {
  return `You are auditing an existing codebase against a client brief. READ-ONLY: do not modify any file.
${ENV_FACTS}
Read the brief at ${BRIEF} (sections ${c.sections}). For EVERY individual requirement / bullet in those sections, find the implementation in ${REPO} (UI route under src/app, domain logic under src/lib, schema in drizzle/*.sql, tests in tests/) and classify it:
- implemented: a user of the right role can actually do/see it in the UI, and the server enforces it.
- partial: exists but a listed field/column/action/role is missing, or it exists in the DB/lib but is not reachable from the UI.
- missing: not there at all.
Be concrete and skeptical: open the page component and check that the listed field is really rendered, the form really has the input, the action really exists. The README claims completeness; do not trust it — verify in code. Cite file:line evidence for every row.
Do NOT flag things the brief explicitly defers (§29 future features, "does NOT need to" statements), and do not flag style preferences. Only flag real functional gaps a client reviewing the brief line-by-line would notice.
Return every requirement row (implemented ones too, briefly) via the structured output.`
}

function verifyPrompt(g, lens) {
  const lensText = lens === 'hunter'
    ? `Your lens: IMPLEMENTATION HUNTER. Try hard to REFUTE the gap by finding the implementation the auditor missed: grep for synonyms, check every page/component/server action/API route, check the form fields, check the workspace/dashboard/search queries. If you find it implemented (the user can do/see it in the UI and the server supports it), refuted=true with file:line proof. If after a thorough search it really is absent or incomplete, refuted=false.`
    : `Your lens: REQUIREMENT READER. Re-read the exact brief text (${BRIEF}) for this requirement. Refute (refuted=true) if the brief does not actually require this for the first version (e.g. it is a §29 future feature, an example rather than a requirement, or the existing behaviour already satisfies the brief's intent in a reasonable way). Otherwise refuted=false. Also judge severity from the perspective of the client reviewing a demo.`
  return `A code auditor claims a gap between the client brief and the codebase at ${REPO}. READ-ONLY: do not modify files.
${ENV_FACTS}
Claimed gap:
- ref: ${g.ref}
- requirement: ${g.requirement}
- status: ${g.status}
- auditor's evidence: ${g.evidence}
- auditor's gap description: ${g.gap}

${lensText}
If the gap is real, give the smallest correct fix sketch (files to touch, how it fits the existing policy layer src/lib/authz and the existing patterns, what test in tests/ to extend). Default to refuted=true only if you have concrete evidence.`
}

async function auditBranch() {
  const results = await pipeline(
    CLUSTERS,
    (c) => agent(auditPrompt(c), { label: `audit:${c.key}`, phase: 'Audit', schema: AUDIT_SCHEMA }),
    async (res, c) => {
      if (!res) return { cluster: c.key, rows: [], gaps: [] }
      const gaps = res.requirements.filter((r) => r.status !== 'implemented')
      const judged = await parallel(gaps.map((g, i) => () =>
        parallel(['hunter', 'reader'].map((lens) => () =>
          agent(verifyPrompt(g, lens), { label: `verify:${c.key}#${i}:${lens}`, phase: 'Verify gaps', schema: VERDICT_SCHEMA })))
          .then((vs) => {
            const [hunter, reader] = vs
            return { ...g, cluster: c.key, hunter, reader }
          })))
      return { cluster: c.key, rows: res.requirements, gaps: judged.filter(Boolean) }
    },
  )
  return results.filter(Boolean)
}

// ------------------------------------------------------------------ seed --
const SEED_PROMPT = `Build a realistic, deterministic DEMO SEED for the Aktivacity portal in ${REPO}. The user asked for the portal "with realistic seed data" that runs entirely locally, with documented default logins.
${ENV_FACTS}
YOUR FILES (you own these; create them):
- scripts/seed-demo.ts  — the seed. Run as: DATABASE_URL=... STORAGE_ROOT=... node --conditions=react-server --import tsx scripts/seed-demo.ts [--reset]
- scripts/demo-assets/  — small committed binary assets the seed copies (see Files below). Keep the whole folder under ~1.5 MB.
Do NOT edit package.json, README.md, .env*, or anything under src/ — another agent owns package.json/env and the README comes later. EXCEPTION: if seeding exposes a genuine bug in src/lib (the domain layer refuses a legitimate operation or corrupts state), make the minimal fix, run the related tests (DATABASE_URL=postgres://aktivacity@localhost:54329/aktivacity_test npm test -- only if needed; the full suite takes ~2 min), and REPORT it in your result. Never weaken a permission check to make seeding easier.

Use for your iteration: DATABASE_URL=postgres://aktivacity@localhost:54329/aktivacity_dev and STORAGE_ROOT=${SCRATCH}/demo-storage . Apply migrations first: DATABASE_URL=... npx tsx scripts/migrate.ts . You may dropdb/createdb aktivacity_dev freely (never aktivacity_test).

APPROACH (important):
1. Go through the REAL domain layer so every invariant, status derivation, notification and activity_log row is produced exactly as in production: fileProject, triageProject, createAssignment, createUploadSession/appendChunk/completeUpload (src/lib/files/uploads.ts), reviewDeliverable, updateDelivery, createRevision, assignRevision, closeRevision, addComment, changeProjectStatus, closeMonth, copyMonth / "open next month", logTime, setCostRate, createOpportunity/moveOpportunity/loseOpportunity/winOpportunity, draftFromMonth/issueInvoice/markPaid, updateBillingSettings, createPortalLogin, clientDecide, updateClientProfile/saveContact, attachments (see src/lib/files/uploads.ts for target 'project' | 'assignment' | 'revision'), etc. Read each function's input type and validation first. Build Actors with loadActorById (src/lib/auth/actor.ts) after inserting users, so leads/permissions are real. A rough older example of calling these functions exists at ~/.cache/aktivacity-dev/seed-demo.ts (reference only; it hand-builds actors — prefer loadActorById).
   Users, department_members, clients and client_contacts may be inserted with SQL if there is no domain function for them (check src/app/admin/users/actions.ts and src/app/clients/actions.ts / src/lib/clients for what exists and mirror their rules; hash passwords with hashPassword from src/lib/auth/password.ts).
2. HISTORY: the data must look like ~9 months of real use centred on TODAY = 2026-09-24 (use the real current date from the machine for relative logic but design around it). Domain functions stamp now(). Implement a "clock" helper, e.g. at(when: Date, fn): record the real DB time before fn, run it, then for every timestamptz column in every table (discover them from information_schema, exclude things like sessions.expires_at if unsuitable) rewrite rows whose value >= the recorded start to 'when' plus a small monotonic increment so ordering is preserved. Run the seed sequentially so this is exact. Where a domain function validates dates against today (deadlines, assignment dates, time entries ≤31 days back, periods offered by monthOptions, etc.), create with valid values and then correct the stored dates with SQL, keeping every derived invariant consistent (e.g. do not leave a closed month containing an open project). Verify afterwards that activity feeds read chronologically and nothing is dated in the future except deadlines/end dates/October planning.
3. DETERMINISM: no Math.random — use a small seeded PRNG. Re-running with --reset must produce the same dataset.
4. SAFETY: without --reset, refuse to run if the users table already has rows (print how to use --reset). With --reset, TRUNCATE every application table (RESTART IDENTITY CASCADE) except _migrations, departments and any other reference rows a migration inserts (inspect drizzle/*.sql for INSERTs, e.g. billing settings / sequences — reset sequences like project_code_sequence and invoice_number_sequence properly), and delete STORAGE_ROOT/files and STORAGE_ROOT/tmp contents. Refuse --reset when NODE_ENV=production.
5. Print a clear summary at the end: counts per table, projects per status, and the login table.

DATASET (fictional Dubai creative agency; realistic names, emails, copy, AED pricing — amounts plausible for UAE agencies, e.g. 4,500–85,000 AED per project):
- Password for EVERY seeded account: Aktivacity@2026 (meets the ≥12 chars letters+numbers policy). must_change_password=false for demo accounts.
- Staff (role in brackets; department membership for leads/executives; emails @aktivacity.local):
  admin@ Portal Administrator [admin]; ceo@ Khalid Al Mansoori [ceo]; coo@ Priya Raman [coo];
  sales@ Omar Haddad [sales]; lina.farouk@ Lina Farouk [sales];
  pm@ Daniel Reyes [project_manager]; fatima.noor@ Fatima Noor [project_manager];
  Team leads: video.lead@ Hassan Qureshi (Video); design.lead@ Maya Chen (Design); dev.lead@ Arjun Mehta (Development); social.lead@ Nour El-Sayed (Social Media); seo.lead@ Rachel Adams (SEO);
  Executives: ahmed@ Ahmed Karim (Video — the brief's "Ahmed"), yusuf.rahman@ Yusuf Rahman (Video), bilal.sheikh@ Bilal Sheikh (Video); sara.ali@ Sara Ali (Design), zainab.hussain@ Zainab Hussain (Design), tom.becker@ Tom Becker (Design); kevin.dsouza@ Kevin D'Souza (Development), rohan.iyer@ Rohan Iyer (Development); aisha.malik@ Aisha Malik (Social Media), layla.mansour@ Layla Mansour (Social Media); imran.khan@ Imran Khan (SEO), hannah.brooks@ Hannah Brooks (SEO).
  Plus one deactivated former employee (e.g. james.whitfield@, Design executive, is_active=false) for user-management realism, and sensible per-user permission grants if the schema supports them (e.g. one PM granted export_reports if not already implied — check can.ts).
- Cost rates (AED/hour) for all production staff via setCostRate (as ceo), effective from 2026-01-01, one raise mid-year for someone.
- Billing settings (as ceo): Aktivacity FZ-LLC, Dubai address, a TRN, 5% VAT, bank details, payment terms.
- Clients (owner = a sales rep; with contacts, client type, status, start date, services, notes):
  1. Al Noor Real Estate — retainer since Jan 2026 (owner Omar). Every month Jan–Sep 2026: ~3–4 projects (social media videos [Video], social designs [Design], SEO monthly work [SEO], community management / content calendar [Social Media]); a website update in some months [Development]. Jan–Aug fully completed/delivered and CLOSED via closeMonth. September = current month with work in many stages (see statuses). October 2026 opened via copy-forward from September (projects filed as 'new', i.e. in the PM's Project Closure Report). This is the brief's "ABC Company" showcase: the client page must show 10 months, 9 of them with history.
  2. Desert Bloom Cafés — retainer since May 2026 (owner Lina): social media + design; May–Aug closed; September active; one project flagged recurring.
  3. Gulf Horizon Hotels — project client (owner Omar): August brand-film project delivered+completed; September "Autumn Staycation" video campaign in revision (Revision #01 closed earlier, Revision #02 open with the brief's example feedback "Please change the opening scene and update the logo placement.").
  4. Falcon Logistics — website rebuild in September (owner Lina): Development + Design + SEO, PM QA required for Development; some deliverables awaiting PM QA, some awaiting lead QA.
  5. Oasis Dental Clinics — retainer since Mar 2026 (owner Lina): SEO + social; one September project ON HOLD (clinic renovation), others in progress. Mar–Jul closed; August left open with everything delivered but not yet closed (so the "close month" button has something to do).
  6. Summit Sports Academy — new client this month (owner Omar): one project just filed ('new', unrouted), one partially routed ('awaiting_assignment').
  7. Marina Motors — one September project CANCELLED with a reason (budget withdrawn), plus a lost pipeline deal.
  8. Nimbus Fintech — prospect with an open pipeline deal (Proposal sent). A couple more pipeline deals across Lead/Qualified/Negotiation (new prospect names), and one WON deal that filed a real project (winOpportunity path).
- September 2026 must cover EVERY project status at least once: new, awaiting_assignment, planned, in_progress, qa, revision_required, approved (if reachable — check syncProjectStatus), ready_for_delivery, delivered, completed, on_hold, cancelled. Verify with a GROUP BY at the end and adjust the scenario until all reachable statuses are present (report any status the code can never reach).
- Assignments with realistic titles/instructions/priorities/start-end dates/estimated hours, deliverable counts 1–10 (e.g. "10 Social Media Videos" as 10 slots split across two executives); progress in September partially done (e.g. 6/10). Multiple executives from different teams on one project (shared workspace: video + thumbnails + SEO copy + social assets).
- QA history with realistic lead/PM comments: first-pass approvals, "request changes" and rejections followed by v2/v3 uploads; some slots awaiting lead QA and some awaiting PM QA right now so the QA panels are non-empty for video.lead, design.lead, dev.lead and pm@.
- Deliveries in every delivery status (pending_delivery, delivered, client_feedback_received, revision_required, completed) with notes like "Sent via WeTransfer link" / "Shared on client's Google Drive".
- Revisions: several across clients, with titles, client feedback, details, deliverables, priority, deadline, attachments (markup PNG/PDF), comments; assigned to executives; revised uploads tagged with the revision; one closed, one cancelled, some open.
- Comments: realistic workspace threads (project-level and slot-level) between executives, leads and PM.
- Attachments: PO PDFs / brief PDFs on projects, reference images on assignments, markup on revisions.
- Time entries: last ~3 weeks of weekday logs for executives on their current assignments (plausible 4–8 h/day, never >24h/day); older months may be inserted directly with SQL if logTime refuses dates >31 days back, so productivity reports for past months are populated.
- Invoices: Al Noor & Desert Bloom paid for Jun–Jul, issued (unpaid) for August, a draft for September; one voided invoice with a reason.
- Client portal: a login for Al Noor (marketing@alnoor-realestate.example, same password) created via createPortalLogin, then its password set to the demo password; delivered files visible; one client approval via clientDecide and one change request. Portal logins should also be documented in your result.
- Notifications: produced naturally by the domain layer. After history rewriting, mark notifications older than ~5 days as read so every role has a realistic handful unread.
- Recurring flag on at least one retainer project (check how the recurring feature stores it). Do not let the seed trigger runRecurring.

FILES: every upload must be a real, openable file so Preview works. Generate small committed assets NOW using ffmpeg on this machine into scripts/demo-assets/: a few short MP4s (H.264 + yuv420p + faststart, 3–5 s, 640x360 or 360x640, colour/test-pattern with drawtext titles if drawtext is available — keep each ≤150 KB), a few PNG/JPG images (thumbnails, social posts, markup; ≤60 KB each). PDFs can be generated at seed time by a tiny hand-written PDF writer (valid xref) with real text (PO, SEO report, blog article, brief). Reuse assets under different realistic filenames (e.g. AlNoor_Sep_Reel_03.mp4, Thumbnail_Launch_v2.png, SEO_Report_Sep_2026.pdf). Upload through the real resumable upload functions so storage paths and checksums are right.

VERIFY before you finish (iterate until all pass):
- Fresh run: dropdb/createdb aktivacity_dev, migrate, seed → exit 0 in reasonable time (< ~3 min). Then run again WITHOUT --reset → refuses cleanly. Then with --reset → exit 0 and identical counts.
- SQL sanity: all September statuses present; Al Noor has months Jan–Oct 2026 with Jan–Aug closed; no project in a closed month is open; every deliverable's file exists on disk under STORAGE_ROOT with matching size; project codes AKT-2026-NNNN increase with filing date; no timestamps in the future except deadlines/end dates.
- Call the read-side functions as each role (write a throwaway check script in ${SCRATCH}, not in the repo): loadDashboard for ceo, pm, sales, video.lead, ahmed; qaQueue for video.lead/design.lead/dev.lead/pm; deliveryQueue for sales; myWork for ahmed; searchProjects('Al Noor') as ceo and as ahmed (ahmed must see only his projects); monthSummaries for Al Noor; inbox for each of those users (non-empty, some unread); loadPortfolioReport for last month; loadProductivityReport for this and last month; listInvoices; listOpportunities; portalProjects for the client login. All must return sensible non-empty data without throwing.
- npx tsc --noEmit passes for your script (if errors are only in .next/types from a concurrent build, re-run).

Return a concise report: files created, how to run, the full login table (email / role / name / team), what the dataset contains (clients, months, counts per status), any src/ fixes you made (with reason), any statuses unreachable, runtime, and anything the README must mention (e.g. STORAGE_ROOT must be the same for the seed and the server).`

// ------------------------------------------------------------ local run --
const LOCAL_PROMPT = `Make the Aktivacity portal in ${REPO} turnkey to run ENTIRELY LOCALLY on a developer/office machine without Docker, cloud services or hosted databases, and make sure it "runs cleanly".
${ENV_FACTS}
Another agent is concurrently writing scripts/seed-demo.ts (+ scripts/demo-assets/) — do not touch those; it will be run as: node --conditions=react-server --import tsx scripts/seed-demo.ts [--reset] and needs DATABASE_URL and STORAGE_ROOT. Do NOT edit README.md (it is rewritten later) — instead return precise notes for it. Do not modify src/ unless strictly required for local running (report any change).

YOUR TASKS:
1. .env loading for CLI scripts. Today \`npm run db:migrate\` etc. run tsx scripts that read process.env but never load .env, so the README's "cp .env.example .env; npm run db:migrate" is broken. Fix the npm scripts (package.json) so db:migrate, db:seed, files:sweep, projects:recurring, notifications:dispatch and the new ones load .env if present (e.g. node --env-file-if-exists=.env ...; verify the flag works on the installed Node v25 and on Node 22 LTS semantics; set "engines": {"node": ">=22.12"} or whatever is truly required — check what the code/deps need). Real environment variables must still win over .env. Do NOT make \`npm test\` load .env (tests would pollute the demo DB) — keep it using an explicit DATABASE_URL.
2. New npm scripts: "db:seed:demo" (the seed above, loading .env), "db:reset:demo" (same with --reset), "setup" (one command for a fresh checkout: create .env from the local template if missing, run migrations, run the demo seed; must be re-runnable: if data already exists, say so and skip seeding rather than failing), and "db:local" helper (below). Keep existing scripts' behaviour.
3. A local env template: create .env.local.example? No — Next.js would treat names starting with .env.local specially only when named exactly .env.local, but .gitignore ignores ".env*" except .env.example, so add a gitignore exception for whatever template you create. Recommended name: .env.development.example is ALSO risky? (Next loads .env.development in dev — but .env.development.example is not loaded.) Choose a safe name, e.g. ".env.local-dev.example" or "env/local.env.example", add the gitignore exception, and make "npm run setup" copy it to .env. Contents: DATABASE_URL pointing at the local Postgres from task 4, STORAGE_ROOT=./storage (relative — verify storageRoot() resolves it against the cwd for both scripts and the Next server, and that ./storage is gitignored), NEXT_TELEMETRY_DISABLED=1, all optional integrations blank (explain each is off), no NODE_ENV (let next set it). Keep .env.example as the production/Docker template but add a short note at its top pointing local users to the local template.
4. scripts/local-postgres.sh (macOS/Linux, POSIX sh): "init|start|stop|status|psql" for a PROJECT-LOCAL PostgreSQL cluster in ./.data/postgres (gitignore it) on port 5433 by default (PGPORT override), using initdb/pg_ctl found on PATH or in common Homebrew/apt locations (/opt/homebrew/opt/postgresql@17/bin, /usr/local/opt/postgresql@*/bin, /usr/lib/postgresql/*/bin). init creates role aktivacity (password aktivacity, superuser is fine for local dev because migrations may create extensions — check drizzle/*.sql for CREATE EXTENSION) and database aktivacity; start is idempotent; it listens on localhost only. Clear error messages if PostgreSQL is not installed, with install hints (brew install postgresql@17 / apt install postgresql). Expose as "npm run db:local -- <cmd>" (or db:local:start etc. — your call, keep it simple). TEST IT on this machine: init+start on 5433, run migrations against it, stop it, then DELETE the ./.data directory you created so the user's tree is clean (leave the script). Don't touch the existing 54329 cluster.
5. Telemetry / outbound calls: ensure the default local configuration makes no outbound network calls from the app. Verify empirically that NEXT_TELEMETRY_DISABLED=1 placed in .env is honoured by \`next build\`/\`next start\` (e.g. NEXT_TELEMETRY_DEBUG=1 shows nothing is sent / "telemetry disabled"); if .env is read too late, put it where it works (npm script env is not cross-platform — consider next.config.ts setting process.env.NEXT_TELEMETRY_DISABLED ??= '1' if that is early enough, and verify). Note: next dev fetches the npm registry once for a version-staleness badge and silently ignores failure — document it rather than hack Next. Grep src/ for any fetch to external hosts, <link>/<script> to CDNs, Google Fonts, analytics; report findings.
6. \`npm run build\` then \`npm start\`: next.config.ts sets output: "standalone" for the Docker image. Check whether \`next start\` then warns or misbehaves (Next 16 may say "next start does not work with output: standalone"). If so, make standalone opt-in for Docker (e.g. output: process.env.NEXT_OUTPUT_STANDALONE === '1' ? 'standalone' : undefined, and set that ENV in the Dockerfile build stage) so local \`npm start\` is clean while the Docker image still gets .next/standalone. Verify: with DATABASE_URL=postgres://aktivacity@localhost:54329/aktivacity_test and STORAGE_ROOT=${SCRATCH}/local-run-storage, run the production build and start it on port 3210 (PORT=3210), curl /login (200), /api/health, and / (redirect to login). Also run \`next dev\` on port 3211 briefly and curl /login. Kill the servers when done. Check server logs for warnings/errors and fix causes that are ours.
   Also check how the app behaves if STORAGE_ROOT is unset or DATABASE_URL is unset/unreachable (clear error message rather than a cryptic crash at the login page is good; do not over-engineer).
7. Windows note: \`npm run setup\` must work cross-platform (write it as a Node script, e.g. scripts/setup.mjs or .ts, not bash). The local-postgres helper can be POSIX-only; the README will tell Windows users to install PostgreSQL and point DATABASE_URL at it.
8. Run \`npm run typecheck\` and \`npm run lint\` at the end; both must pass.

Return: every file you created/changed with a one-line why, the exact quick-start command sequence you verified (copy-pasteable), verified outputs (HTTP codes), telemetry/outbound-call findings, Node version requirement, and notes for the README.`

// ------------------------------------------------------------------ run --
const [audit, seed, local] = await parallel([
  () => auditBranch(),
  () => agent(SEED_PROMPT, { label: 'seed:build', phase: 'Seed' }),
  () => agent(LOCAL_PROMPT, { label: 'local:turnkey', phase: 'Local run' }),
])

const allRows = (audit || []).flatMap((c) => c.rows.map((r) => ({ cluster: c.cluster, ...r })))
const gaps = (audit || []).flatMap((c) => c.gaps)
const confirmed = gaps.filter((g) => g.hunter && !g.hunter.refuted)
const refuted = gaps.filter((g) => !g.hunter || g.hunter.refuted)
log(`audit: ${allRows.length} requirements, ${gaps.length} claimed gaps, ${confirmed.length} survive the hunter`)

return {
  audit: {
    totals: {
      requirements: allRows.length,
      implemented: allRows.filter((r) => r.status === 'implemented').length,
      claimedGaps: gaps.length,
      confirmedByHunter: confirmed.length,
    },
    confirmed: confirmed.map((g) => ({
      cluster: g.cluster, ref: g.ref, requirement: g.requirement, gap: g.gap,
      hunter: g.hunter, reader: g.reader,
    })),
    refuted: refuted.map((g) => ({ cluster: g.cluster, ref: g.ref, gap: g.gap, why: g.hunter ? g.hunter.reasoning : 'hunter failed' })),
  },
  seed,
  local,
}
