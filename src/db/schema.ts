/**
 * Drizzle schema — mirrors drizzle/0001_init.sql, which is the source of truth.
 *
 * This file exists for typed queries only. Constraints, indexes and checks are
 * declared in SQL, not here. `npm test` fails if the two drift apart.
 */
import {
  bigint,
  boolean,
  char,
  date,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
  unique,
} from 'drizzle-orm/pg-core';

const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const fk = (name: string) => bigint(name, { mode: 'number' });
const ts = (name: string) => timestamp(name, { withTimezone: true });
const now = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ enums */

export const userRole = pgEnum('user_role', [
  'ceo', 'coo', 'admin', 'sales', 'project_manager', 'team_lead', 'executive', 'client',
]);
export const permissionKey = pgEnum('permission_key', [
  'view_pricing', 'manage_users', 'close_month', 'reopen_month',
  'delete_files', 'export_reports', 'view_all_clients',
  // A restriction, not a grant: withholds downloads from one account (§43).
  'no_download',
]);
export const clientStatus = pgEnum('client_status', ['prospect', 'active', 'paused', 'churned']);
export const opportunityStage = pgEnum('opportunity_stage', ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']);
export const clientType = pgEnum('client_type', ['retainer', 'one_off']);
export const monthStatus = pgEnum('month_status', ['open', 'closed']);
export const priorityLevel = pgEnum('priority_level', ['low', 'normal', 'high', 'urgent']);
export const projectStatus = pgEnum('project_status', [
  'new', 'awaiting_assignment', 'planned', 'in_progress', 'qa', 'revision_required',
  'approved', 'ready_for_delivery', 'delivered', 'completed', 'on_hold', 'cancelled',
]);
export const assignmentStatus = pgEnum('assignment_status', [
  'planned', 'in_progress', 'submitted', 'completed', 'cancelled',
]);
export const deliverableStatus = pgEnum('deliverable_status', [
  'pending', 'in_progress', 'awaiting_lead_qa', 'changes_requested',
  'awaiting_pm_qa', 'approved', 'delivered', 'cancelled',
]);
export const qaStage = pgEnum('qa_stage', ['team_lead', 'project_manager']);
export const qaDecision = pgEnum('qa_decision', ['approved', 'rejected', 'changes_requested']);
export const deliveryStatus = pgEnum('delivery_status', [
  'pending_delivery', 'delivered', 'client_feedback_received', 'revision_required', 'completed',
]);
export const uploadTarget = pgEnum('upload_target', ['deliverable', 'attachment']);
export const revisionStatus = pgEnum('revision_status', [
  'new', 'assigned', 'in_progress', 'awaiting_qa', 'approved', 'delivered', 'closed', 'cancelled',
]);

/* ------------------------------------------------------- identity & access */

export const departments = pgTable('departments', {
  id: id(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  isProduction: boolean('is_production').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
});

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  fullName: text('full_name').notNull(),
  role: userRole('role').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  mustChangePassword: boolean('must_change_password').notNull().default(true),
  lastLoginAt: ts('last_login_at'),
  deactivatedAt: ts('deactivated_at'),
  /** Set for, and only for, client portal logins (brief §29). */
  clientId: fk('client_id').references((): AnyPgColumn => clients.id),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const departmentMembers = pgTable('department_members', {
  id: id(),
  userId: fk('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  departmentId: fk('department_id').notNull().references(() => departments.id),
  isLead: boolean('is_lead').notNull().default(false),
  createdAt: now('created_at'),
});

export const userPermissions = pgTable('user_permissions', {
  id: id(),
  userId: fk('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  permission: permissionKey('permission').notNull(),
  grantedBy: fk('granted_by').notNull().references(() => users.id),
  grantedAt: now('granted_at'),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: fk('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  createdAt: now('created_at'),
});

/* ------------------------------------------------------------------ clients */

export const clients = pgTable('clients', {
  id: id(),
  name: text('name').notNull(),
  companyName: text('company_name'),
  status: clientStatus('status').notNull().default('active'),
  clientType: clientType('client_type').notNull().default('retainer'),
  ownerUserId: fk('owner_user_id').references(() => users.id),
  startedOn: date('started_on'),
  portalAutoDeliver: boolean('portal_auto_deliver').notNull().default(false),
  notes: text('notes'),
  createdBy: fk('created_by').notNull().references(() => users.id),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const clientContacts = pgTable('client_contacts', {
  id: id(),
  clientId: fk('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  jobTitle: text('job_title'),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: now('created_at'),
});

export const clientServices = pgTable('client_services', {
  clientId: fk('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  departmentId: fk('department_id').notNull().references(() => departments.id),
  notes: text('notes'),
}, (t) => [primaryKey({ columns: [t.clientId, t.departmentId] })]);

export const clientMonths = pgTable('client_months', {
  id: id(),
  clientId: fk('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  periodYear: integer('period_year').notNull(),
  periodMonth: integer('period_month').notNull(),
  status: monthStatus('status').notNull().default('open'),
  notes: text('notes'),
  closedAt: ts('closed_at'),
  closedBy: fk('closed_by').references(() => users.id),
  /** Set when management reopens an archived month; the nightly archive then leaves it to be closed by hand. */
  reopenedAt: ts('reopened_at'),
  createdBy: fk('created_by').notNull().references(() => users.id),
  createdAt: now('created_at'),
});

/* ----------------------------------------------------------------- projects */

export const projectCodeSequence = pgTable('project_code_sequence', {
  periodYear: integer('period_year').primaryKey(),
  lastNumber: integer('last_number').notNull().default(0),
});

export const projects = pgTable('projects', {
  id: id(),
  projectCode: text('project_code').notNull(),
  clientId: fk('client_id').notNull().references(() => clients.id),
  clientMonthId: fk('client_month_id').notNull(),
  title: text('title').notNull(),
  objective: text('objective'),
  description: text('description'),
  projectType: text('project_type'),
  poReference: text('po_reference'),
  requirements: text('requirements'),
  clientNotes: text('client_notes'),
  // "Other relevant project information" (brief §3): the last intake field.
  otherInfo: text('other_info'),
  internalNotes: text('internal_notes'),
  deadline: date('deadline'),
  priority: priorityLevel('priority').notNull().default('normal'),
  status: projectStatus('status').notNull().default('new'),
  priceAmount: numeric('price_amount', { precision: 14, scale: 2 }),
  priceCurrency: char('price_currency', { length: 3 }).notNull().default('USD'),
  salesOwnerId: fk('sales_owner_id').notNull().references(() => users.id),
  projectManagerId: fk('project_manager_id').references(() => users.id),
  // The QA route Sales chose at intake (brief §13): the default that seeds
  // every team row filed with the project, and any team the PM adds later
  // without saying. Not derived from the teams; the route actually enforced
  // is project_departments.requires_pm_qa, set per team by triage and the
  // edit form. A month copy, and the nightly recurring copy, carry each
  // team's own value to the copied team; only a team added in the copy
  // takes this default.
  requiresPmQa: boolean('requires_pm_qa').notNull().default(true),
  heldFromStatus: projectStatus('held_from_status'),
  copiedFromProjectId: fk('copied_from_project_id'),
  recursMonthly: boolean('recurs_monthly').notNull().default(false),
  assignedAt: ts('assigned_at'),
  completedAt: ts('completed_at'),
  createdBy: fk('created_by').notNull().references(() => users.id),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const projectDepartments = pgTable('project_departments', {
  id: id(),
  projectId: fk('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  departmentId: fk('department_id').notNull().references(() => departments.id),
  teamLeadId: fk('team_lead_id').references(() => users.id),
  // Per team (brief §13): read by qa/review to decide awaiting_pm_qa vs approved.
  requiresPmQa: boolean('requires_pm_qa').notNull().default(true),
  plannedDeliverables: integer('planned_deliverables').notNull().default(0),
  briefNotes: text('brief_notes'),
  assignedBy: fk('assigned_by').references(() => users.id),
  assignedAt: ts('assigned_at'),
  createdAt: now('created_at'),
});

export const assignments = pgTable('assignments', {
  id: id(),
  projectDepartmentId: fk('project_department_id').notNull(),
  projectId: fk('project_id').notNull(),
  assigneeId: fk('assignee_id').notNull().references(() => users.id),
  assignedBy: fk('assigned_by').notNull().references(() => users.id),
  title: text('title').notNull(),
  instructions: text('instructions'),
  startDate: date('start_date'),
  endDate: date('end_date'),
  priority: priorityLevel('priority').notNull().default('normal'),
  status: assignmentStatus('status').notNull().default('planned'),
  estimatedMinutes: integer('estimated_minutes'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const deliverables = pgTable('deliverables', {
  id: id(),
  projectId: fk('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  projectDepartmentId: fk('project_department_id').notNull(),
  assignmentId: fk('assignment_id'),
  sequenceNo: integer('sequence_no').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  status: deliverableStatus('status').notNull().default('pending'),
  dueDate: date('due_date'),
  createdBy: fk('created_by').notNull().references(() => users.id),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

/* -------------------------------------------------------- files & versions */

export const files = pgTable('files', {
  id: id(),
  storageKey: uuid('storage_key').notNull().defaultRandom(),
  storagePath: text('storage_path').notNull(),
  originalFilename: text('original_filename').notNull(),
  mimeType: text('mime_type'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  checksumSha256: text('checksum_sha256'),
  uploadedBy: fk('uploaded_by').notNull().references(() => users.id),
  uploadedAt: now('uploaded_at'),
  deletedAt: ts('deleted_at'),
  deletedBy: fk('deleted_by').references(() => users.id),
});

export const deliverableVersions = pgTable('deliverable_versions', {
  id: id(),
  deliverableId: fk('deliverable_id').notNull().references(() => deliverables.id, { onDelete: 'cascade' }),
  versionNo: integer('version_no').notNull(),
  fileId: fk('file_id').notNull().references(() => files.id),
  revisionId: fk('revision_id'),
  notes: text('notes'),
  uploadedBy: fk('uploaded_by').notNull().references(() => users.id),
  uploadedAt: now('uploaded_at'),
  isCurrent: boolean('is_current').notNull().default(true),
});

/* ---------------------------------------------------------------------- QA */

export const qaReviews = pgTable('qa_reviews', {
  id: id(),
  deliverableVersionId: fk('deliverable_version_id').notNull().references(() => deliverableVersions.id, { onDelete: 'cascade' }),
  stage: qaStage('stage').notNull(),
  roundNo: integer('round_no').notNull().default(1),
  reviewerId: fk('reviewer_id').notNull().references(() => users.id),
  decision: qaDecision('decision').notNull(),
  comments: text('comments'),
  reviewedAt: now('reviewed_at'),
});

/* -------------------------------------------------------------- deliveries */

export const deliveries = pgTable('deliveries', {
  id: id(),
  projectId: fk('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  deliverableId: fk('deliverable_id').notNull(),
  deliverableVersionId: fk('deliverable_version_id').notNull().references(() => deliverableVersions.id),
  status: deliveryStatus('status').notNull().default('pending_delivery'),
  approvedAt: ts('approved_at'),
  deliveredAt: ts('delivered_at'),
  deliveredBy: fk('delivered_by').references(() => users.id),
  clientDecision: text('client_decision'),
  clientDecidedBy: fk('client_decided_by').references(() => users.id),
  clientDecidedAt: ts('client_decided_at'),
  clientFeedback: text('client_feedback'),
  notes: text('notes'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

/* --------------------------------------------------------------- revisions */

export const revisions = pgTable('revisions', {
  id: id(),
  projectId: fk('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  revisionNo: integer('revision_no').notNull(),
  title: text('title').notNull(),
  clientFeedback: text('client_feedback').notNull(),
  details: text('details'),
  priority: priorityLevel('priority').notNull().default('normal'),
  deadline: date('deadline'),
  status: revisionStatus('status').notNull().default('new'),
  createdBy: fk('created_by').notNull().references(() => users.id),
  closedAt: ts('closed_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const revisionDeliverables = pgTable('revision_deliverables', {
  revisionId: fk('revision_id').notNull(),
  deliverableId: fk('deliverable_id').notNull(),
  projectId: fk('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.revisionId, t.deliverableId] })]);

/* --------------------------------------- comments, attachments, feeds, log */

export const comments = pgTable('comments', {
  id: id(),
  authorId: fk('author_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  projectId: fk('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  assignmentId: fk('assignment_id').references(() => assignments.id, { onDelete: 'cascade' }),
  deliverableId: fk('deliverable_id').references(() => deliverables.id, { onDelete: 'cascade' }),
  revisionId: fk('revision_id').references(() => revisions.id, { onDelete: 'cascade' }),
  // A thread on one upload (brief §10, §19); the CHECK keeps exactly one parent.
  versionId: fk('version_id').references(() => deliverableVersions.id, { onDelete: 'cascade' }),
  isInternal: boolean('is_internal').notNull().default(true),
  createdAt: now('created_at'),
  editedAt: ts('edited_at'),
});

export const attachments = pgTable('attachments', {
  id: id(),
  fileId: fk('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
  projectId: fk('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  assignmentId: fk('assignment_id').references(() => assignments.id, { onDelete: 'cascade' }),
  revisionId: fk('revision_id').references(() => revisions.id, { onDelete: 'cascade' }),
  commentId: fk('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
  purpose: text('purpose'),
  // 'po' (the PO document, brief §3, always project-parented) or 'reference'.
  kind: text('kind').notNull().default('reference'),
  createdAt: now('created_at'),
});

export const notifications = pgTable('notifications', {
  id: id(),
  userId: fk('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  linkPath: text('link_path'),
  entityType: text('entity_type'),
  entityId: fk('entity_id'),
  isRead: boolean('is_read').notNull().default(false),
  readAt: ts('read_at'),
  createdAt: now('created_at'),
});

export const activityLog = pgTable('activity_log', {
  id: id(),
  actorId: fk('actor_id').references(() => users.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: fk('entity_id'),
  projectId: fk('project_id').references(() => projects.id, { onDelete: 'set null' }),
  clientId: fk('client_id').references(() => clients.id, { onDelete: 'set null' }),
  metadata: jsonb('metadata').notNull().default({}),
  ipAddress: inet('ip_address'),
  createdAt: now('created_at'),
});

/* --------------------------------------------------- resumable uploads ---- */

export const uploadSessions = pgTable('upload_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdBy: fk('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  target: uploadTarget('target').notNull(),
  deliverableId: fk('deliverable_id').references(() => deliverables.id, { onDelete: 'cascade' }),
  projectId: fk('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  assignmentId: fk('assignment_id').references(() => assignments.id, { onDelete: 'cascade' }),
  revisionId: fk('revision_id').references(() => revisions.id, { onDelete: 'cascade' }),
  purpose: text('purpose'),
  // Carried to completion with the parent: 'po' or 'reference'.
  kind: text('kind').notNull().default('reference'),
  originalFilename: text('original_filename').notNull(),
  mimeType: text('mime_type'),
  declaredSize: bigint('declared_size', { mode: 'number' }).notNull(),
  bytesReceived: bigint('bytes_received', { mode: 'number' }).notNull().default(0),
  tempPath: text('temp_path').notNull(),
  expectedChecksum: text('expected_checksum'),
  notes: text('notes'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
  expiresAt: ts('expires_at').notNull(),
  completedAt: ts('completed_at'),
  fileId: fk('file_id').references(() => files.id),
});

/* ------------------------------------------------------- time tracking ---- */

export const timeEntries = pgTable('time_entries', {
  id: id(),
  assignmentId: fk('assignment_id').notNull(),
  projectId: fk('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: fk('user_id').notNull().references(() => users.id),
  workDate: date('work_date').notNull(),
  minutes: integer('minutes').notNull(),
  note: text('note'),
  createdAt: now('created_at'),
});

/* ---------------------------------------------------------- cost rates ---- */

export const userCostRates = pgTable('user_cost_rates', {
  userId: fk('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  effectiveFrom: date('effective_from').notNull(),
  hourlyCost: numeric('hourly_cost', { precision: 10, scale: 2 }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  setBy: fk('set_by').notNull().references(() => users.id),
  setAt: now('set_at'),
}, (t) => [primaryKey({ columns: [t.userId, t.effectiveFrom] })]);

/* ------------------------------------------------------- sales pipeline ---- */

export const opportunities = pgTable('opportunities', {
  id: id(),
  clientId: fk('client_id').notNull().references(() => clients.id),
  ownerUserId: fk('owner_user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  stage: opportunityStage('stage').notNull().default('lead'),
  estimatedValue: numeric('estimated_value', { precision: 14, scale: 2 }),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  expectedClose: date('expected_close'),
  notes: text('notes'),
  lostReason: text('lost_reason'),
  wonProjectId: fk('won_project_id').unique().references(() => projects.id),
  closedAt: ts('closed_at'),
  createdBy: fk('created_by').notNull().references(() => users.id),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

/* --------------------------------------------- outbound notification channels */

export const userChannelPrefs = pgTable('user_channel_prefs', {
  userId: fk('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  address: text('address'),
  updatedAt: now('updated_at'),
}, (t) => [primaryKey({ columns: [t.userId, t.channel] })]);

export const notificationDispatches = pgTable('notification_dispatches', {
  notificationId: fk('notification_id').notNull().references(() => notifications.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  sentAt: ts('sent_at'),
  createdAt: now('created_at'),
}, (t) => [primaryKey({ columns: [t.notificationId, t.channel] })]);

/* ------------------------------------------------------------- invoices ---- */

export const invoiceStatus = pgEnum('invoice_status', ['draft', 'issued', 'paid', 'void']);

export const billingSettings = pgTable('billing_settings', {
  id: integer('id').primaryKey().default(1),
  companyName: text('company_name').notNull().default('Aktivacity'),
  companyAddress: text('company_address'),
  taxRegistration: text('tax_registration'),
  defaultVatRate: numeric('default_vat_rate', { precision: 5, scale: 2 }).notNull().default('5.00'),
  paymentTermsDays: integer('payment_terms_days').notNull().default(30),
  paymentDetails: text('payment_details'),
  footerNote: text('footer_note'),
  updatedBy: fk('updated_by').references(() => users.id),
  updatedAt: now('updated_at'),
});

export const invoiceNumberSequence = pgTable('invoice_number_sequence', {
  periodYear: integer('period_year').primaryKey(),
  lastNumber: integer('last_number').notNull().default(0),
});

export const invoices = pgTable('invoices', {
  id: id(),
  invoiceNo: text('invoice_no').unique(),
  clientId: fk('client_id').notNull().references(() => clients.id),
  clientMonthId: fk('client_month_id').references(() => clientMonths.id),
  status: invoiceStatus('status').notNull().default('draft'),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull(),
  subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
  vatAmount: numeric('vat_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
  issueDate: date('issue_date'),
  dueDate: date('due_date'),
  notes: text('notes'),
  createdBy: fk('created_by').notNull().references(() => users.id),
  createdAt: now('created_at'),
  issuedBy: fk('issued_by').references(() => users.id),
  issuedAt: ts('issued_at'),
  paidAt: date('paid_at'),
  voidedAt: ts('voided_at'),
  voidReason: text('void_reason'),
  updatedAt: now('updated_at'),
});

export const invoiceLines = pgTable('invoice_lines', {
  id: id(),
  invoiceId: fk('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  projectId: fk('project_id').references(() => projects.id),
  position: integer('position').notNull(),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull().default('1'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
}, (t) => [unique().on(t.invoiceId, t.position)]);

/* ------------------------------------------------------ AI summaries ------ */

export const projectSummaries = pgTable('project_summaries', {
  projectId: fk('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  audience: text('audience').notNull(),
  summary: text('summary').notNull(),
  model: text('model').notNull(),
  generatedBy: fk('generated_by').notNull().references(() => users.id),
  generatedAt: now('generated_at'),
}, (t) => [primaryKey({ columns: [t.projectId, t.audience] })]);

/* ---------------------------------------------------- project sharing ---- */

export const projectViewers = pgTable('project_viewers', {
  projectId: fk('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: fk('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  grantedBy: fk('granted_by').notNull().references(() => users.id),
  grantedAt: now('granted_at'),
}, (t) => [primaryKey({ columns: [t.projectId, t.userId] })]);
