import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import type { Actor } from '@/lib/authz';
import { can, clientScope } from '@/lib/authz';
import { isClientVisible } from '@/lib/projects/queries';
import { normalizeCurrency } from '@/lib/currency';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export class InvoiceError extends Error {}

/**
 * Invoices (brief §29, automated invoices), drafted from what the portal
 * already knows — a client's priced projects for a month (§32) — so nobody
 * re-types an order into a spreadsheet. A project is billed on at most one
 * live invoice. Drafts are free to edit; issuing numbers the invoice
 * (INV-YYYY-NNNN, gap-free, in issue order) and freezes it. A wrong invoice
 * is voided with a reason, never edited or deleted, so the books can be
 * trusted.
 */

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';

export function canManageInvoices(actor: Actor): boolean {
  return can(actor, 'invoices.manage');
}

/** Invoices for the clients this actor may see. */
function invoiceScope(actor: Actor, clientAlias = 'c'): SQL {
  return canManageInvoices(actor) ? clientScope(actor, clientAlias) : sql`FALSE`;
}

/**
 * Line amounts, subtotal, VAT and total, rounded to the fils. Worked in whole
 * fils, so binary fractions cannot tip a half-fils the wrong way.
 */
export function computeTotals(lines: { quantity: number; unitPrice: number }[], vatRate: number) {
  const fils = lines.map((l) => Math.round(l.quantity * Math.round(l.unitPrice * 100)));
  const subtotal = fils.reduce((s, a) => s + a, 0);
  const vat = Math.round((subtotal * Math.round(vatRate * 100)) / 10000);
  return { amounts: fils.map((f) => f / 100), subtotal: subtotal / 100, vat: vat / 100, total: (subtotal + vat) / 100 };
}

export interface BillingSettings {
  companyName: string;
  companyAddress: string | null;
  taxRegistration: string | null;
  defaultVatRate: number;
  paymentTermsDays: number;
  paymentDetails: string | null;
  footerNote: string | null;
}

export async function billingSettings(): Promise<BillingSettings> {
  const [r] = await getDb().execute<{
    company_name: string; company_address: string | null; tax_registration: string | null;
    default_vat_rate: string; payment_terms_days: number; payment_details: string | null; footer_note: string | null;
  }>(sql`SELECT * FROM billing_settings WHERE id = 1`);
  return {
    companyName: r.company_name, companyAddress: r.company_address, taxRegistration: r.tax_registration,
    defaultVatRate: Number(r.default_vat_rate), paymentTermsDays: Number(r.payment_terms_days),
    paymentDetails: r.payment_details, footerNote: r.footer_note,
  };
}

export async function updateBillingSettings(actor: Actor, s: BillingSettings): Promise<void> {
  if (!can(actor, 'invoices.configure')) throw new InvoiceError('You are not permitted to change billing settings.');
  if (!s.companyName.trim()) throw new InvoiceError('Enter the company name.');
  if (!(s.defaultVatRate >= 0 && s.defaultVatRate <= 100)) throw new InvoiceError('Enter a VAT rate between 0 and 100.');
  if (!(Number.isInteger(s.paymentTermsDays) && s.paymentTermsDays >= 0 && s.paymentTermsDays <= 365)) {
    throw new InvoiceError('Enter payment terms between 0 and 365 days.');
  }
  await getDb().execute(sql`
    UPDATE billing_settings SET company_name = ${s.companyName.trim()}, company_address = ${s.companyAddress},
      tax_registration = ${s.taxRegistration}, default_vat_rate = ${s.defaultVatRate.toFixed(2)},
      payment_terms_days = ${s.paymentTermsDays}, payment_details = ${s.paymentDetails},
      footer_note = ${s.footerNote}, updated_by = ${actor.id}, updated_at = now()
    WHERE id = 1
  `);
}

/** Projects in a month that carry a price and are not on a live invoice. */
async function billableProjects(db: Db | Tx, clientMonthId: number) {
  return db.execute<{ id: number; project_code: string; title: string; price_amount: string; price_currency: string }>(sql`
    SELECT p.id, p.project_code, p.title, p.price_amount::text AS price_amount, p.price_currency
    FROM projects p
    WHERE p.client_month_id = ${clientMonthId} AND p.status <> 'cancelled' AND p.price_amount IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
                      WHERE l.project_id = p.id AND i.status <> 'void')
    ORDER BY p.project_code
  `);
}

async function recalc(tx: Tx, invoiceId: number): Promise<void> {
  const lines = await tx.execute<{ id: number; quantity: string; unit_price: string }>(sql`
    SELECT id, quantity::text AS quantity, unit_price::text AS unit_price FROM invoice_lines
    WHERE invoice_id = ${invoiceId} ORDER BY position`);
  const [inv] = await tx.execute<{ vat_rate: string }>(sql`SELECT vat_rate::text AS vat_rate FROM invoices WHERE id = ${invoiceId}`);
  const t = computeTotals(lines.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unit_price) })), Number(inv.vat_rate));
  for (let i = 0; i < lines.length; i++) {
    await tx.execute(sql`UPDATE invoice_lines SET amount = ${t.amounts[i].toFixed(2)} WHERE id = ${lines[i].id}`);
  }
  await tx.execute(sql`
    UPDATE invoices SET subtotal = ${t.subtotal.toFixed(2)}, vat_amount = ${t.vat.toFixed(2)}, total = ${t.total.toFixed(2)}
    WHERE id = ${invoiceId}`);
}

/**
 * Drafts an invoice for one client-month from its priced, unbilled projects.
 * Refuses when there is nothing to bill or the prices are in more than one
 * currency.
 */
export async function draftFromMonth(actor: Actor, input: { clientMonthId: number }): Promise<{ invoiceId: number; lines: number }> {
  if (!canManageInvoices(actor)) throw new InvoiceError('You are not permitted to manage invoices.');
  const db = getDb();
  const [month] = await db.execute<{ client_id: number }>(sql`SELECT client_id FROM client_months WHERE id = ${input.clientMonthId}`);
  if (!month || !(await isClientVisible(db, actor, Number(month.client_id)))) throw new InvoiceError('No such month.');
  const settings = await billingSettings();

  return db.transaction(async (tx) => {
    // One drafter per month at a time, so two clicks cannot bill a project twice.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('invoice-month'), ${input.clientMonthId}::int)`);
    const projects = await billableProjects(tx, input.clientMonthId);
    if (projects.length === 0) throw new InvoiceError('Nothing to invoice: every priced project this month is already billed.');
    const currencies = new Set(projects.map((p) => normalizeCurrency(p.price_currency)));
    if (currencies.size > 1) throw new InvoiceError(`These projects are priced in ${[...currencies].join(' and ')}; invoice them separately.`);

    const invoiceCurrency = normalizeCurrency(projects[0].price_currency);
    const [inv] = await tx.execute<{ id: number }>(sql`
      INSERT INTO invoices (client_id, client_month_id, currency, vat_rate, created_by)
      VALUES (${month.client_id}, ${input.clientMonthId}, ${invoiceCurrency},
              ${settings.defaultVatRate.toFixed(2)}, ${actor.id})
      RETURNING id`);
    const invoiceId = Number(inv.id);
    let position = 1;
    for (const p of projects) {
      await tx.execute(sql`
        INSERT INTO invoice_lines (invoice_id, project_id, position, description, quantity, unit_price, amount)
        VALUES (${invoiceId}, ${p.id}, ${position++}, ${`${p.project_code} — ${p.title}`}, 1, ${p.price_amount}, ${p.price_amount})`);
    }
    await recalc(tx, invoiceId);
    return { invoiceId, lines: projects.length };
  });
}

/** A blank draft for anything not tied to a month's projects. */
export async function draftBlank(actor: Actor, input: { clientId: number }): Promise<{ invoiceId: number }> {
  if (!canManageInvoices(actor)) throw new InvoiceError('You are not permitted to manage invoices.');
  const db = getDb();
  if (!(await isClientVisible(db, actor, input.clientId))) throw new InvoiceError('Choose a client.');
  const settings = await billingSettings();
  const [inv] = await db.execute<{ id: number }>(sql`
    INSERT INTO invoices (client_id, currency, vat_rate, created_by)
    VALUES (${input.clientId}, 'USD', ${settings.defaultVatRate.toFixed(2)}, ${actor.id}) RETURNING id`);
  return { invoiceId: Number(inv.id) };
}

/** Loads an invoice the actor may manage, locked, for a change. */
async function lockOwn(tx: Tx, actor: Actor, invoiceId: number) {
  const [row] = await tx.execute<{ id: number; status: InvoiceStatus; client_id: number; currency: string }>(sql`
    SELECT i.id, i.status, i.client_id, i.currency FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.id = ${invoiceId} AND ${invoiceScope(actor)}
    FOR UPDATE OF i`);
  if (!row) throw new InvoiceError('No such invoice.');
  return row;
}

async function assertDraft(tx: Tx, actor: Actor, invoiceId: number) {
  if (!canManageInvoices(actor)) throw new InvoiceError('You are not permitted to manage invoices.');
  const row = await lockOwn(tx, actor, invoiceId);
  if (row.status !== 'draft') throw new InvoiceError('An issued invoice cannot be changed. Void it and draft a new one.');
  return row;
}

export interface LineInput { description: string; quantity: number; unitPrice: number }

function validLine(l: LineInput): LineInput {
  const description = l.description.trim();
  if (!description) throw new InvoiceError('Describe the line.');
  if (!(Number.isFinite(l.quantity) && l.quantity > 0)) throw new InvoiceError('Enter a quantity above zero.');
  if (!(Number.isFinite(l.unitPrice) && l.unitPrice >= 0)) throw new InvoiceError('Enter a valid unit price.');
  return { description, quantity: l.quantity, unitPrice: l.unitPrice };
}

export async function saveDraft(
  actor: Actor,
  input: { invoiceId: number; lines: (LineInput & { id?: number })[]; notes: string | null; vatRate: number; currency: string },
): Promise<void> {
  if (!(input.vatRate >= 0 && input.vatRate <= 100)) throw new InvoiceError('Enter a VAT rate between 0 and 100.');
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new InvoiceError('Enter a three-letter currency.');
  const lines = input.lines.map((l) => ({ ...validLine(l), id: l.id }));
  await getDb().transaction(async (tx) => {
    await assertDraft(tx, actor, input.invoiceId);
    const kept = lines.filter((l) => l.id !== undefined).map((l) => l.id!);
    await tx.execute(sql`
      DELETE FROM invoice_lines WHERE invoice_id = ${input.invoiceId}
      ${kept.length > 0 ? sql`AND id NOT IN (${sql.join(kept.map((k) => sql`${k}`), sql`, `)})` : sql``}`);
    // Positions are rewritten in form order; move them clear of the unique
    // (invoice, position) pair first.
    await tx.execute(sql`UPDATE invoice_lines SET position = position + 100000 WHERE invoice_id = ${input.invoiceId}`);
    let position = 1;
    for (const l of lines) {
      if (l.id !== undefined) {
        const updated = await tx.execute(sql`
          UPDATE invoice_lines SET position = ${position}, description = ${l.description},
                 quantity = ${l.quantity}, unit_price = ${l.unitPrice.toFixed(2)}
          WHERE id = ${l.id} AND invoice_id = ${input.invoiceId} RETURNING id`);
        if (updated.length === 0) throw new InvoiceError('A line on this form belongs to another invoice.');
      } else {
        await tx.execute(sql`
          INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price, amount)
          VALUES (${input.invoiceId}, ${position}, ${l.description}, ${l.quantity}, ${l.unitPrice.toFixed(2)}, 0)`);
      }
      position++;
    }
    await tx.execute(sql`
      UPDATE invoices SET notes = ${input.notes?.trim() || null}, vat_rate = ${input.vatRate.toFixed(2)}, currency = ${currency}
      WHERE id = ${input.invoiceId}`);
    await recalc(tx, input.invoiceId);
  });
}

export async function deleteDraft(actor: Actor, invoiceId: number): Promise<void> {
  await getDb().transaction(async (tx) => {
    await assertDraft(tx, actor, invoiceId);
    await tx.execute(sql`DELETE FROM invoices WHERE id = ${invoiceId}`);
  });
}

/** Numbers and freezes a draft. The number is taken in the same transaction, so it is gap-free. */
export async function issueInvoice(actor: Actor, invoiceId: number, today = new Date()): Promise<{ invoiceNo: string }> {
  const settings = await billingSettings();
  return getDb().transaction(async (tx) => {
    await assertDraft(tx, actor, invoiceId);
    const [count] = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM invoice_lines WHERE invoice_id = ${invoiceId}`);
    if (Number(count.n) === 0) throw new InvoiceError('Add at least one line before issuing.');
    const year = today.getUTCFullYear();
    const [seq] = await tx.execute<{ last_number: number }>(sql`
      INSERT INTO invoice_number_sequence (period_year, last_number) VALUES (${year}, 1)
      ON CONFLICT (period_year) DO UPDATE SET last_number = invoice_number_sequence.last_number + 1
      RETURNING last_number`);
    const invoiceNo = `INV-${year}-${String(Number(seq.last_number)).padStart(4, '0')}`;
    const issueDate = today.toISOString().slice(0, 10);
    const due = new Date(today.getTime() + settings.paymentTermsDays * 86_400_000).toISOString().slice(0, 10);
    await tx.execute(sql`
      UPDATE invoices SET status = 'issued', invoice_no = ${invoiceNo}, issue_date = ${issueDate}, due_date = ${due},
             issued_by = ${actor.id}, issued_at = now()
      WHERE id = ${invoiceId}`);
    return { invoiceNo };
  });
}

export async function markPaid(actor: Actor, input: { invoiceId: number; paidOn: string }): Promise<void> {
  if (!canManageInvoices(actor)) throw new InvoiceError('You are not permitted to manage invoices.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw new InvoiceError('Enter the date it was paid.');
  await getDb().transaction(async (tx) => {
    const row = await lockOwn(tx, actor, input.invoiceId);
    if (row.status !== 'issued') throw new InvoiceError('Only an issued invoice can be marked paid.');
    await tx.execute(sql`UPDATE invoices SET status = 'paid', paid_at = ${input.paidOn} WHERE id = ${input.invoiceId}`);
  });
}

/** Voids an issued or paid invoice. Its projects become billable again; the number stays used. */
export async function voidInvoice(actor: Actor, input: { invoiceId: number; reason: string }): Promise<void> {
  if (!canManageInvoices(actor)) throw new InvoiceError('You are not permitted to manage invoices.');
  const reason = input.reason.trim();
  if (!reason) throw new InvoiceError('Say why it is being voided.');
  await getDb().transaction(async (tx) => {
    const row = await lockOwn(tx, actor, input.invoiceId);
    if (row.status === 'draft') throw new InvoiceError('Delete a draft instead of voiding it.');
    if (row.status === 'void') throw new InvoiceError('This invoice is already void.');
    await tx.execute(sql`
      UPDATE invoices SET status = 'void', voided_at = now(), void_reason = ${reason.slice(0, 500)},
             paid_at = NULL
      WHERE id = ${input.invoiceId}`);
  });
}

export interface InvoiceSummary {
  id: number;
  invoiceNo: string | null;
  status: InvoiceStatus;
  clientId: number;
  clientName: string;
  period: { year: number; month: number } | null;
  currency: string;
  total: number;
  issueDate: string | null;
  dueDate: string | null;
  paidAt: string | null;
  overdue: boolean;
}

const SUMMARY = sql`
  i.id, i.invoice_no, i.status, i.client_id, c.name AS client_name, cm.period_year, cm.period_month,
  i.currency, i.total::text AS total, i.issue_date::text AS issue_date, i.due_date::text AS due_date,
  i.paid_at::text AS paid_at, (i.status = 'issued' AND i.due_date < CURRENT_DATE) AS overdue`;

type SummaryRow = {
  id: number; invoice_no: string | null; status: InvoiceStatus; client_id: number; client_name: string;
  period_year: number | null; period_month: number | null; currency: string; total: string;
  issue_date: string | null; due_date: string | null; paid_at: string | null; overdue: boolean;
};
const toSummary = (r: SummaryRow): InvoiceSummary => ({
  id: Number(r.id), invoiceNo: r.invoice_no, status: r.status, clientId: Number(r.client_id), clientName: r.client_name,
  period: r.period_year ? { year: Number(r.period_year), month: Number(r.period_month) } : null,
  currency: r.currency, total: Number(r.total), issueDate: r.issue_date, dueDate: r.due_date, paidAt: r.paid_at,
  overdue: r.overdue === true,
});

export async function listInvoices(actor: Actor, opts: { status?: InvoiceStatus; clientId?: number } = {}): Promise<InvoiceSummary[]> {
  if (!canManageInvoices(actor)) return [];
  const rows = await getDb().execute<SummaryRow>(sql`
    SELECT ${SUMMARY}
    FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN client_months cm ON cm.id = i.client_month_id
    WHERE ${invoiceScope(actor)}
      ${opts.status ? sql`AND i.status = ${opts.status}` : sql``}
      ${opts.clientId ? sql`AND i.client_id = ${opts.clientId}` : sql``}
    ORDER BY (i.status = 'draft') DESC, i.issue_date DESC NULLS FIRST, i.id DESC
  `);
  return rows.map(toSummary);
}

export interface InvoiceDetail extends InvoiceSummary {
  vatRate: number;
  subtotal: number;
  vatAmount: number;
  notes: string | null;
  voidReason: string | null;
  client: { name: string; companyName: string | null };
  lines: { id: number; projectId: number | null; projectCode: string | null; description: string; quantity: number; unitPrice: number; amount: number }[];
}

async function detail(where: SQL): Promise<InvoiceDetail | null> {
  const db = getDb();
  const [r] = await db.execute<SummaryRow & {
    vat_rate: string; subtotal: string; vat_amount: string; notes: string | null; void_reason: string | null; company_name: string | null;
  }>(sql`
    SELECT ${SUMMARY}, i.vat_rate::text AS vat_rate, i.subtotal::text AS subtotal, i.vat_amount::text AS vat_amount,
           i.notes, i.void_reason, c.company_name
    FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN client_months cm ON cm.id = i.client_month_id
    WHERE ${where}`);
  if (!r) return null;
  const lines = await db.execute<{ id: number; project_id: number | null; project_code: string | null; description: string; quantity: string; unit_price: string; amount: string }>(sql`
    SELECT l.id, l.project_id, p.project_code, l.description, l.quantity::text AS quantity,
           l.unit_price::text AS unit_price, l.amount::text AS amount
    FROM invoice_lines l LEFT JOIN projects p ON p.id = l.project_id
    WHERE l.invoice_id = ${r.id} ORDER BY l.position`);
  return {
    ...toSummary(r),
    vatRate: Number(r.vat_rate), subtotal: Number(r.subtotal), vatAmount: Number(r.vat_amount),
    notes: r.notes, voidReason: r.void_reason,
    client: { name: r.client_name, companyName: r.company_name },
    lines: lines.map((l) => ({
      id: Number(l.id), projectId: l.project_id === null ? null : Number(l.project_id), projectCode: l.project_code,
      description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unit_price), amount: Number(l.amount),
    })),
  };
}

export async function getInvoice(actor: Actor, invoiceId: number): Promise<InvoiceDetail | null> {
  if (!canManageInvoices(actor)) return null;
  return detail(sql`i.id = ${invoiceId} AND ${invoiceScope(actor)}`);
}

/** A client portal login sees its own client's issued and paid invoices, never drafts. */
export async function getClientInvoice(actor: Actor, invoiceId: number): Promise<InvoiceDetail | null> {
  if (actor.role !== 'client' || !actor.clientId || !actor.isActive) return null;
  return detail(sql`i.id = ${invoiceId} AND i.client_id = ${actor.clientId} AND i.status IN ('issued','paid')`);
}

export async function clientInvoices(actor: Actor): Promise<InvoiceSummary[]> {
  if (actor.role !== 'client' || !actor.clientId || !actor.isActive) return [];
  const rows = await getDb().execute<SummaryRow>(sql`
    SELECT ${SUMMARY}
    FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN client_months cm ON cm.id = i.client_month_id
    WHERE i.client_id = ${actor.clientId} AND i.status IN ('issued','paid')
    ORDER BY i.issue_date DESC, i.id DESC`);
  return rows.map(toSummary);
}

export interface ReadyToInvoice {
  clientMonthId: number;
  clientId: number;
  clientName: string;
  period: { year: number; month: number };
  projects: number;
  amount: number;
  currency: string;
}

/** Client-months with priced work not yet on any live invoice: what is waiting to be billed. */
export async function readyToInvoice(actor: Actor): Promise<ReadyToInvoice[]> {
  if (!canManageInvoices(actor)) return [];
  const rows = await getDb().execute<{
    client_month_id: number; client_id: number; client_name: string; period_year: number; period_month: number;
    projects: number; amount: string; currency: string;
  }>(sql`
    SELECT cm.id AS client_month_id, c.id AS client_id, c.name AS client_name, cm.period_year, cm.period_month,
           count(*)::int AS projects, sum(p.price_amount)::text AS amount, min(p.price_currency) AS currency
    FROM projects p
    JOIN client_months cm ON cm.id = p.client_month_id
    JOIN clients c ON c.id = p.client_id
    WHERE p.status <> 'cancelled' AND p.price_amount IS NOT NULL AND ${invoiceScope(actor)}
      AND NOT EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
                      WHERE l.project_id = p.id AND i.status <> 'void')
    GROUP BY cm.id, c.id, c.name, cm.period_year, cm.period_month
    ORDER BY cm.period_year DESC, cm.period_month DESC, c.name
  `);
  return rows.map((r) => ({
    clientMonthId: Number(r.client_month_id), clientId: Number(r.client_id), clientName: r.client_name,
    period: { year: Number(r.period_year), month: Number(r.period_month) },
    projects: Number(r.projects), amount: Number(r.amount), currency: r.currency,
  }));
}

/**
 * The automation: a draft for every client-month in a period that has priced
 * work waiting. Drafts only — a person still reads and issues each one.
 */
export async function draftAllForPeriod(
  actor: Actor,
  period: { year: number; month: number },
): Promise<{ drafted: { invoiceId: number; clientName: string }[]; skipped: { clientName: string; reason: string }[] }> {
  const ready = (await readyToInvoice(actor)).filter((r) => r.period.year === period.year && r.period.month === period.month);
  const drafted: { invoiceId: number; clientName: string }[] = [];
  const skipped: { clientName: string; reason: string }[] = [];
  for (const r of ready) {
    try {
      const d = await draftFromMonth(actor, { clientMonthId: r.clientMonthId });
      drafted.push({ invoiceId: d.invoiceId, clientName: r.clientName });
    } catch (error) {
      if (error instanceof InvoiceError) skipped.push({ clientName: r.clientName, reason: error.message });
      else throw error;
    }
  }
  return { drafted, skipped };
}
