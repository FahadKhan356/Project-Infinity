-- ============================================================================
-- Aktivacity Central Project Portal — canonical data model
-- PostgreSQL 17. Source of truth for Phase 1a.
--
-- Spine (brief §27 / §34 / §47):
--   client -> client_month -> project -> project_department -> assignment
--          -> deliverable -> deliverable_version -> file
--
-- Design rules enforced here:
--   1. A project can span several departments, each with its own Team Lead
--      and its own QA queue (brief §10 vs §5).
--   2. A deliverable is a SLOT with a status. Files are versions attached to
--      the slot. Re-uploading after a rejection does NOT advance progress
--      (brief §7 / §11 / §19).
--   3. Composite foreign keys prevent a row from pointing at a parent in a
--      different project. This is a permission boundary, not a nicety.
--   4. Clients are selected, never typed. Free-text client names are the
--      failure mode that breaks all monthly history (brief §31 vs §3).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- global search (§22)

-- ---------------------------------------------------------------- enums ----

CREATE TYPE user_role          AS ENUM ('ceo','coo','admin','sales','project_manager','team_lead','executive');
CREATE TYPE permission_key     AS ENUM ('view_pricing','manage_users','close_month','reopen_month','delete_files','export_reports','view_all_clients');
CREATE TYPE client_status      AS ENUM ('prospect','active','paused','churned');
CREATE TYPE client_type        AS ENUM ('retainer','one_off');
CREATE TYPE month_status       AS ENUM ('open','closed');
CREATE TYPE priority_level     AS ENUM ('low','normal','high','urgent');

-- §18, verbatim
CREATE TYPE project_status     AS ENUM ('new','awaiting_assignment','planned','in_progress','qa',
                                        'revision_required','approved','ready_for_delivery','delivered',
                                        'completed','on_hold','cancelled');

CREATE TYPE assignment_status  AS ENUM ('planned','in_progress','submitted','completed','cancelled');

-- The deliverable slot lifecycle. 'approved' = passed every required QA stage
-- and is now visible in Sales -> Deliveries (§14).
CREATE TYPE deliverable_status AS ENUM ('pending','in_progress','awaiting_lead_qa','changes_requested',
                                        'awaiting_pm_qa','approved','delivered','cancelled');

CREATE TYPE qa_stage           AS ENUM ('team_lead','project_manager');
CREATE TYPE qa_decision        AS ENUM ('approved','rejected','changes_requested');
CREATE TYPE delivery_status    AS ENUM ('pending_delivery','delivered','client_feedback_received','revision_required','completed');  -- §14
CREATE TYPE revision_status    AS ENUM ('new','assigned','in_progress','awaiting_qa','approved','delivered','closed','cancelled');

-- ------------------------------------------------------ updated_at helper --

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

-- ================================================== identity & access ======

CREATE TABLE departments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  -- production departments receive project work; sales/PM/management do not
  is_production boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE users (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          text NOT NULL,
  password_hash  text NOT NULL,              -- argon2id
  full_name      text NOT NULL,
  role           user_role NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  deactivated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which teams a person belongs to, and whether they lead one.
-- A Team Lead may lead more than one department in a small agency.
CREATE TABLE department_members (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id bigint NOT NULL REFERENCES departments(id),
  is_lead       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, department_id)
);
CREATE INDEX department_members_dept_idx ON department_members (department_id, is_lead);

-- Per-user grants layered on top of the role. Covers §23's
-- "no pricing visibility unless specifically authorized".
CREATE TABLE user_permissions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission permission_key NOT NULL,
  granted_by bigint NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, permission)
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  ip_address  inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ============================================================ clients ======

CREATE TABLE clients (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  company_name  text,
  status        client_status NOT NULL DEFAULT 'active',
  client_type   client_type   NOT NULL DEFAULT 'retainer',
  owner_user_id bigint REFERENCES users(id),        -- sales representative (§31)
  started_on    date,
  notes         text,
  created_by    bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Hard stop on "ABC Company" / "ABC Co." / "abc company" drift.
CREATE UNIQUE INDEX clients_name_lower_key ON clients (lower(name));
CREATE INDEX clients_owner_idx ON clients (owner_user_id);
CREATE INDEX clients_name_trgm ON clients USING gin (name gin_trgm_ops);
CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE client_contacts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id  bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text,
  phone      text,
  job_title  text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_contacts_client_idx ON client_contacts (client_id);

-- "services being provided" (§31)
CREATE TABLE client_services (
  client_id     bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  department_id bigint NOT NULL REFERENCES departments(id),
  notes         text,
  PRIMARY KEY (client_id, department_id)
);

-- ====================================================== monthly buckets ====

CREATE TABLE client_months (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id    bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period_year  int NOT NULL CHECK (period_year BETWEEN 2020 AND 2100),
  period_month int NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  status       month_status NOT NULL DEFAULT 'open',
  notes        text,
  closed_at    timestamptz,
  closed_by    bigint REFERENCES users(id),
  created_by   bigint NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, period_year, period_month),
  -- lets projects prove their month belongs to their client (see below)
  UNIQUE (id, client_id)
);
CREATE INDEX client_months_lookup_idx ON client_months (client_id, period_year DESC, period_month DESC);

-- =========================================================== projects ======

CREATE TABLE project_code_sequence (
  period_year int PRIMARY KEY,
  last_number int NOT NULL DEFAULT 0
);

CREATE TABLE projects (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_code        text NOT NULL UNIQUE,            -- AKT-2026-0001 (§24)
  client_id           bigint NOT NULL REFERENCES clients(id),
  client_month_id     bigint NOT NULL,
  title               text NOT NULL,
  objective           text,
  description         text,
  project_type        text,
  po_reference        text,
  requirements        text,
  client_notes        text,
  internal_notes      text,
  deadline            date,
  priority            priority_level NOT NULL DEFAULT 'normal',
  status              project_status NOT NULL DEFAULT 'new',
  -- pricing: restricted at the query layer, never sent to unauthorized clients (§3/§23)
  price_amount        numeric(14,2),
  price_currency      char(3) NOT NULL DEFAULT 'AED',
  -- ownership
  sales_owner_id      bigint NOT NULL REFERENCES users(id),
  project_manager_id  bigint REFERENCES users(id),     -- null until triaged (§5)
  -- QA policy for this project (§13); applied to each project_department
  requires_pm_qa      boolean NOT NULL DEFAULT true,
  copied_from_project_id bigint REFERENCES projects(id),  -- §38 copy-month lineage
  assigned_at         timestamptz,
  completed_at        timestamptz,
  created_by          bigint NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- the month must belong to the same client as the project
  FOREIGN KEY (client_month_id, client_id) REFERENCES client_months (id, client_id),
  -- lets children prove they belong to this project
  UNIQUE (id, client_id)
);
CREATE INDEX projects_month_idx   ON projects (client_month_id);
CREATE INDEX projects_client_idx  ON projects (client_id, created_at DESC);
CREATE INDEX projects_status_idx  ON projects (status) WHERE status NOT IN ('completed','cancelled');
CREATE INDEX projects_pm_idx      ON projects (project_manager_id);
CREATE INDEX projects_sales_idx   ON projects (sales_owner_id);
CREATE INDEX projects_deadline_idx ON projects (deadline) WHERE status NOT IN ('completed','cancelled');
CREATE INDEX projects_title_trgm  ON projects USING gin (title gin_trgm_ops);
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per department involved in the project. THIS is what a Team Lead
-- is assigned to — not the project as a whole (§5 reconciled with §10).
CREATE TABLE project_departments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id     bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  department_id  bigint NOT NULL REFERENCES departments(id),
  team_lead_id   bigint REFERENCES users(id),     -- null until PM assigns (§5)
  requires_pm_qa boolean NOT NULL DEFAULT true,   -- seeded from projects.requires_pm_qa
  brief_notes    text,
  assigned_by    bigint REFERENCES users(id),
  assigned_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, department_id),
  UNIQUE (id, project_id)
);
CREATE INDEX project_departments_lead_idx ON project_departments (team_lead_id);
CREATE INDEX project_departments_dept_idx ON project_departments (department_id);

-- ======================================================== assignments ======

CREATE TABLE assignments (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_department_id bigint NOT NULL REFERENCES project_departments(id) ON DELETE CASCADE,
  project_id            bigint NOT NULL,
  assignee_id           bigint NOT NULL REFERENCES users(id),   -- executive
  assigned_by           bigint NOT NULL REFERENCES users(id),   -- team lead
  title                 text NOT NULL,
  instructions          text,
  start_date            date,
  end_date              date,
  priority              priority_level NOT NULL DEFAULT 'normal',
  status                assignment_status NOT NULL DEFAULT 'planned',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_department_id, project_id) REFERENCES project_departments (id, project_id),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  UNIQUE (id, project_department_id)
);
CREATE INDEX assignments_assignee_idx ON assignments (assignee_id, status);
CREATE INDEX assignments_window_idx   ON assignments (start_date, end_date);
CREATE INDEX assignments_pd_idx       ON assignments (project_department_id);
CREATE TRIGGER assignments_updated_at BEFORE UPDATE ON assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ======================================================== deliverables =====
-- A slot, not a file. Progress counts slots, so a v2 after a rejection does
-- not double-count (§7 / §11 / §19).

CREATE TABLE deliverables (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id            bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_department_id bigint NOT NULL,
  assignment_id         bigint,                    -- null = planned but unassigned
  sequence_no           int NOT NULL,              -- "Video 01"
  name                  text NOT NULL,
  description           text,
  status                deliverable_status NOT NULL DEFAULT 'pending',
  due_date              date,
  created_by            bigint NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_department_id, project_id) REFERENCES project_departments (id, project_id),
  FOREIGN KEY (assignment_id, project_department_id) REFERENCES assignments (id, project_department_id),
  UNIQUE (project_department_id, sequence_no),
  UNIQUE (id, project_id)
);
CREATE INDEX deliverables_assignment_idx ON deliverables (assignment_id);
CREATE INDEX deliverables_project_idx    ON deliverables (project_id, status);
CREATE INDEX deliverables_qa_queue_idx   ON deliverables (status)
  WHERE status IN ('awaiting_lead_qa','awaiting_pm_qa');
CREATE TRIGGER deliverables_updated_at BEFORE UPDATE ON deliverables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ======================================================= files & versions ==

CREATE TABLE files (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  storage_key       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),  -- unguessable on-disk name
  storage_path      text NOT NULL,          -- relative to STORAGE_ROOT, outside the web root
  original_filename text NOT NULL,
  mime_type         text,
  size_bytes        bigint NOT NULL,
  checksum_sha256   text,
  uploaded_by       bigint NOT NULL REFERENCES users(id),
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  deleted_by        bigint REFERENCES users(id)
);
CREATE INDEX files_uploader_idx ON files (uploaded_by, uploaded_at DESC);

CREATE TABLE deliverable_versions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deliverable_id bigint NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  version_no     int NOT NULL,                -- 1, 2, 3 ... (§19)
  file_id        bigint NOT NULL REFERENCES files(id),
  revision_id    bigint,                      -- set when this version answers a revision
  notes          text,
  uploaded_by    bigint NOT NULL REFERENCES users(id),
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  is_current     boolean NOT NULL DEFAULT true,
  UNIQUE (deliverable_id, version_no)
);
CREATE UNIQUE INDEX deliverable_versions_one_current
  ON deliverable_versions (deliverable_id) WHERE is_current;
CREATE INDEX deliverable_versions_revision_idx ON deliverable_versions (revision_id);

-- ================================================================= QA ======
-- Append-only history of QA rounds (§12, §13, §25).

CREATE TABLE qa_reviews (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deliverable_version_id bigint NOT NULL REFERENCES deliverable_versions(id) ON DELETE CASCADE,
  stage                 qa_stage NOT NULL,
  round_no              int NOT NULL DEFAULT 1,
  reviewer_id           bigint NOT NULL REFERENCES users(id),
  decision              qa_decision NOT NULL,
  comments              text,
  reviewed_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deliverable_version_id, stage, round_no)
);
CREATE INDEX qa_reviews_reviewer_idx ON qa_reviews (reviewer_id, reviewed_at DESC);

-- =========================================================== deliveries ====

CREATE TABLE deliveries (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id             bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deliverable_id         bigint NOT NULL,
  deliverable_version_id bigint NOT NULL REFERENCES deliverable_versions(id),
  status                 delivery_status NOT NULL DEFAULT 'pending_delivery',
  approved_at            timestamptz,     -- when it cleared final QA
  delivered_at           timestamptz,
  delivered_by           bigint REFERENCES users(id),
  client_feedback        text,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (deliverable_id, project_id) REFERENCES deliverables (id, project_id) ON DELETE CASCADE
);
CREATE INDEX deliveries_queue_idx   ON deliveries (status, created_at DESC);
CREATE INDEX deliveries_project_idx ON deliveries (project_id);
CREATE TRIGGER deliveries_updated_at BEFORE UPDATE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================ revisions ====

CREATE TABLE revisions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id      bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_no     int NOT NULL,                  -- per project: #01, #02, #03 (§15)
  title           text NOT NULL,
  client_feedback text NOT NULL,
  details         text,
  priority        priority_level NOT NULL DEFAULT 'normal',
  deadline        date,
  status          revision_status NOT NULL DEFAULT 'new',
  created_by      bigint NOT NULL REFERENCES users(id),   -- sales
  closed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision_no),
  UNIQUE (id, project_id)
);
CREATE INDEX revisions_status_idx ON revisions (status) WHERE status NOT IN ('closed','cancelled');
CREATE TRIGGER revisions_updated_at BEFORE UPDATE ON revisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE deliverable_versions
  ADD CONSTRAINT deliverable_versions_revision_fk
  FOREIGN KEY (revision_id) REFERENCES revisions(id);

-- A revision can touch several deliverables, and therefore several
-- departments. Team routing is derived from these links (§16).
CREATE TABLE revision_deliverables (
  revision_id    bigint NOT NULL,
  deliverable_id bigint NOT NULL,
  project_id     bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (revision_id, deliverable_id),
  FOREIGN KEY (revision_id, project_id)    REFERENCES revisions (id, project_id)    ON DELETE CASCADE,
  FOREIGN KEY (deliverable_id, project_id) REFERENCES deliverables (id, project_id) ON DELETE CASCADE
);
CREATE INDEX revision_deliverables_deliverable_idx ON revision_deliverables (deliverable_id);

-- ========================================== comments, attachments, feeds ===

CREATE TABLE comments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id      bigint NOT NULL REFERENCES users(id),
  body           text NOT NULL,
  project_id     bigint REFERENCES projects(id) ON DELETE CASCADE,
  assignment_id  bigint REFERENCES assignments(id) ON DELETE CASCADE,
  deliverable_id bigint REFERENCES deliverables(id) ON DELETE CASCADE,
  revision_id    bigint REFERENCES revisions(id) ON DELETE CASCADE,
  is_internal    boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  edited_at      timestamptz,
  CONSTRAINT comments_exactly_one_parent CHECK (
    (project_id IS NOT NULL)::int + (assignment_id IS NOT NULL)::int +
    (deliverable_id IS NOT NULL)::int + (revision_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX comments_project_idx     ON comments (project_id, created_at DESC);
CREATE INDEX comments_deliverable_idx ON comments (deliverable_id, created_at DESC);
CREATE INDEX comments_revision_idx    ON comments (revision_id, created_at DESC);

CREATE TABLE attachments (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id       bigint NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  project_id    bigint REFERENCES projects(id) ON DELETE CASCADE,
  assignment_id bigint REFERENCES assignments(id) ON DELETE CASCADE,
  revision_id   bigint REFERENCES revisions(id) ON DELETE CASCADE,
  comment_id    bigint REFERENCES comments(id) ON DELETE CASCADE,
  purpose       text,                        -- 'po' | 'reference' | 'brief' | ...
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_exactly_one_parent CHECK (
    (project_id IS NOT NULL)::int + (assignment_id IS NOT NULL)::int +
    (revision_id IS NOT NULL)::int + (comment_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX attachments_project_idx  ON attachments (project_id);
CREATE INDEX attachments_revision_idx ON attachments (revision_id);

CREATE TABLE notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,                 -- 'project.created', 'qa.rejected', ...
  title       text NOT NULL,
  body        text,
  link_path   text,
  entity_type text,
  entity_id   bigint,
  is_read     boolean NOT NULL DEFAULT false,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_inbox_idx ON notifications (user_id, is_read, created_at DESC);

-- Append-only. REVOKE UPDATE/DELETE from the application role in production.
CREATE TABLE activity_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    bigint REFERENCES users(id),
  action      text NOT NULL,                 -- 'project.created', 'file.downloaded', ...
  entity_type text NOT NULL,
  entity_id   bigint,
  project_id  bigint REFERENCES projects(id) ON DELETE SET NULL,
  client_id   bigint REFERENCES clients(id) ON DELETE SET NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_log_project_idx ON activity_log (project_id, created_at DESC);
CREATE INDEX activity_log_actor_idx   ON activity_log (actor_id, created_at DESC);
CREATE INDEX activity_log_entity_idx  ON activity_log (entity_type, entity_id, created_at DESC);

-- ================================================== progress convenience ===
-- Progress is APPROVED slots over total slots. Uploaded is reported alongside
-- so a Team Lead can see "5 in, 2 signed off".

CREATE VIEW v_assignment_progress AS
SELECT a.id AS assignment_id,
       count(d.id)                                                    AS total,
       count(*) FILTER (WHERE d.status IN ('approved','delivered'))   AS approved,
       count(*) FILTER (WHERE d.status <> 'pending')                  AS started
FROM assignments a
LEFT JOIN deliverables d ON d.assignment_id = a.id AND d.status <> 'cancelled'
GROUP BY a.id;

CREATE VIEW v_project_progress AS
SELECT p.id AS project_id,
       count(d.id)                                                    AS total,
       count(*) FILTER (WHERE d.status IN ('approved','delivered'))   AS approved,
       count(*) FILTER (WHERE d.status IN ('awaiting_lead_qa','awaiting_pm_qa')) AS in_qa
FROM projects p
LEFT JOIN deliverables d ON d.project_id = p.id AND d.status <> 'cancelled'
GROUP BY p.id;

-- ======================================================== seed departments =
INSERT INTO departments (slug, name, is_production, sort_order) VALUES
  ('video',       'Video',              true,  10),
  ('design',      'Design',             true,  20),
  ('development', 'Development',        true,  30),
  ('social',      'Social Media',       true,  40),
  ('seo',         'SEO',                true,  50),
  ('sales',       'Sales',              false, 60),
  ('pm',          'Project Management', false, 70),
  ('management',  'Management / Admin', false, 80);
