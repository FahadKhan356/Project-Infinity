/**
 * Invoices (brief §29): drafted from a month's priced projects, each project
 * billed once, numbered gap-free on issue, frozen once issued.
 *
 * Needs DATABASE_URL pointing at a migrated database.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import type { Actor, Permission, Role } from '../src/lib/authz/types';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run invoice tests';

describe('invoice arithmetic', () => {
  test('lines, VAT and total round to the fils', async () => {
    const { computeTotals } = await import('../src/lib/invoices/invoices');
    const t = computeTotals([{ quantity: 3, unitPrice: 333.33 }, { quantity: 1.5, unitPrice: 0.1 }], 5);
    assert.deepEqual(t, { amounts: [999.99, 0.15], subtotal: 1000.14, vat: 50.01, total: 1050.15 });
    // 1.005 is 1.00499… in binary; in fils it is exactly 100.5 → 101.
    assert.deepEqual(computeTotals([{ quantity: 1, unitPrice: 20.1 }], 5), { amounts: [20.1], subtotal: 20.1, vat: 1.01, total: 21.11 });
    assert.deepEqual(computeTotals([], 5), { amounts: [], subtotal: 0, vat: 0, total: 0 });
  });
});

describe('invoices (brief §29)', { skip }, () => {
  let sql: ReturnType<typeof postgres>;
  let inv: typeof import('../src/lib/invoices/invoices');
  let fileProject: typeof import('../src/lib/projects/file-project').fileProject;
  let changeProjectStatus: typeof import('../src/lib/projects/status').changeProjectStatus;
  const ids: Record<string, number> = {};
  const DOMAIN = '@invtest.local';
  const YEAR = 2086;
  const actor = (role: Role, id: number, over: Partial<Actor> = {}): Actor => ({
    id, email: `${role}${DOMAIN}`, fullName: role, role, isActive: true, mustChangePassword: false,
    leadDepartmentIds: [], departmentIds: [], permissions: new Set<Permission>(), ...over,
  });
  const sales = () => actor('sales', ids.sales);
  const rival = () => actor('sales', ids.rival);
  const coo = () => actor('coo', ids.coo);
  const pm = () => actor('project_manager', ids.pm);
  const at = (m: number, d = 10) => new Date(Date.UTC(YEAR, m - 1, d, 9));
  let settingsBefore: Awaited<ReturnType<typeof inv.billingSettings>>;

  const project = async (title: string, price: string | null, period = `${YEAR}-04`) => (await fileProject(sales(), {
    clientId: ids.client, period, title, priceAmount: price,
    departments: [{ departmentId: ids.video, plannedDeliverables: 1 }],
  })).projectId;
  async function purge() {
    const users = sql`SELECT id FROM users WHERE email LIKE ${'%' + DOMAIN}`;
    await sql`DELETE FROM invoices WHERE created_by IN (${users})`;
    await sql`DELETE FROM activity_log WHERE actor_id IN (${users})`;
    await sql`DELETE FROM notifications WHERE user_id IN (${users})`;
    await sql`DELETE FROM projects WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'Inv Test%')`;
    await sql`UPDATE billing_settings SET updated_by = NULL WHERE updated_by IN (${users})`;
    await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN} AND role = 'client'`;
    await sql`DELETE FROM clients WHERE name LIKE 'Inv Test%'`;
    await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`;
    await sql`DELETE FROM invoice_number_sequence WHERE period_year = ${YEAR}`;
    await sql`DELETE FROM project_code_sequence WHERE period_year = ${YEAR}`;
  }
  const monthOf = async (projectId: number) =>
    Number((await sql`SELECT client_month_id FROM projects WHERE id = ${projectId}`)[0].client_month_id);

  before(async () => {
    if (skip) return;
    sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
    inv = await import('../src/lib/invoices/invoices');
    ({ fileProject } = await import('../src/lib/projects/file-project'));
    ({ changeProjectStatus } = await import('../src/lib/projects/status'));
    await purge();
    ids.video = Number((await sql`SELECT id FROM departments WHERE slug = 'video'`)[0].id);
    for (const [key, role] of [['sales', 'sales'], ['rival', 'sales'], ['coo', 'coo'], ['pm', 'project_manager']] as const) {
      ids[key] = Number((await sql`INSERT INTO users (email, password_hash, full_name, role)
        VALUES (${key + DOMAIN}, 'x', ${key}, ${role}) RETURNING id`)[0].id);
    }
    ids.client = Number((await sql`INSERT INTO clients (name, owner_user_id, created_by)
      VALUES ('Inv Test Client', ${ids.sales}, ${ids.sales}) RETURNING id`)[0].id);
    settingsBefore = await inv.billingSettings();
    await inv.updateBillingSettings(coo(), { ...settingsBefore, defaultVatRate: 5, paymentTermsDays: 30 });
  });
  after(async () => {
    if (skip || !sql) return;
    await inv.updateBillingSettings(coo(), settingsBefore);
    await purge();
    await sql.end();
  });

  test('a month drafts from its priced, live projects, each billed once', async () => {
    const a = await project('10 reels', '3000.00');
    await project('SEO retainer', '1500.50');
    await project('Unpriced favour', null);
    const dropped = await project('Dropped', '999.00');
    await changeProjectStatus(pm(), { projectId: dropped, change: 'cancel', reason: 'Client withdrew' });
    const month = await monthOf(a);

    const ready = (await inv.readyToInvoice(sales())).find((r) => r.clientMonthId === month)!;
    assert.deepEqual([ready.projects, ready.amount], [2, 4500.5]);

    const d = await inv.draftFromMonth(sales(), { clientMonthId: month });
    const draft = (await inv.getInvoice(sales(), d.invoiceId))!;
    assert.equal(draft.status, 'draft');
    assert.equal(draft.invoiceNo, null);
    assert.equal(draft.lines.length, 2);
    assert.deepEqual([draft.subtotal, draft.vatAmount, draft.total], [4500.5, 225.03, 4725.53]);
    await assert.rejects(inv.draftFromMonth(sales(), { clientMonthId: month }), /already billed/);
    assert.equal((await inv.readyToInvoice(sales())).some((r) => r.clientMonthId === month), false);
    ids.invoice = d.invoiceId;
  });

  test('drafts are edited freely; issuing numbers them in order and freezes them', async () => {
    const draft = (await inv.getInvoice(sales(), ids.invoice))!;
    await inv.saveDraft(sales(), {
      invoiceId: ids.invoice, vatRate: 5, currency: 'aed', notes: 'Thank you for your business',
      lines: [
        { id: draft.lines[1].id, description: draft.lines[1].description, quantity: 1, unitPrice: 1500.5 },
        { id: draft.lines[0].id, description: draft.lines[0].description, quantity: 1, unitPrice: 2800 },
        { description: 'Rush fee', quantity: 2, unitPrice: 100 },
      ],
    });
    const edited = (await inv.getInvoice(sales(), ids.invoice))!;
    assert.deepEqual(edited.lines.map((l) => l.amount), [1500.5, 2800, 200]);
    assert.equal(edited.total, 4725.53);
    assert.equal(edited.lines[0].projectCode !== null && edited.lines[2].projectId === null, true);

    const first = await inv.issueInvoice(sales(), ids.invoice, at(5, 1));
    assert.equal(first.invoiceNo, `INV-${YEAR}-0001`);
    const issued = (await inv.getInvoice(sales(), ids.invoice))!;
    assert.deepEqual([issued.status, issued.issueDate, issued.dueDate], ['issued', `${YEAR}-05-01`, `${YEAR}-05-31`]);
    await assert.rejects(inv.saveDraft(sales(), { invoiceId: ids.invoice, vatRate: 5, currency: 'AED', notes: null, lines: [] }), /cannot be changed/);
    await assert.rejects(inv.deleteDraft(sales(), ids.invoice), /cannot be changed/);

    const blank = await inv.draftBlank(sales(), { clientId: ids.client });
    await assert.rejects(inv.issueInvoice(sales(), blank.invoiceId, at(5, 2)), /at least one line/);
    await inv.saveDraft(sales(), { invoiceId: blank.invoiceId, vatRate: 0, currency: 'AED', notes: null,
      lines: [{ description: 'Consulting', quantity: 1, unitPrice: 500 }] });
    assert.equal((await inv.issueInvoice(sales(), blank.invoiceId, at(5, 2))).invoiceNo, `INV-${YEAR}-0002`);
  });

  test('paid, then voided with a reason; the projects become billable again', async () => {
    await assert.rejects(inv.markPaid(sales(), { invoiceId: ids.invoice, paidOn: 'soon' }), /date/);
    await inv.markPaid(sales(), { invoiceId: ids.invoice, paidOn: `${YEAR}-05-20` });
    assert.equal((await inv.getInvoice(sales(), ids.invoice))!.status, 'paid');
    await assert.rejects(inv.voidInvoice(sales(), { invoiceId: ids.invoice, reason: ' ' }), /Say why/);
    await inv.voidInvoice(sales(), { invoiceId: ids.invoice, reason: 'Wrong entity on the header' });
    const voided = (await inv.getInvoice(sales(), ids.invoice))!;
    assert.deepEqual([voided.status, voided.paidAt, voided.invoiceNo], ['void', null, `INV-${YEAR}-0001`]);
    const month = await monthOf(voided.lines[0].projectId!);
    const again = await inv.draftFromMonth(sales(), { clientMonthId: month });
    assert.equal((await inv.getInvoice(sales(), again.invoiceId))!.lines.length, 2);
    await inv.deleteDraft(sales(), again.invoiceId);
  });

  test('scoping and permissions', async () => {
    assert.equal(await inv.getInvoice(rival(), ids.invoice), null, 'another rep’s client');
    assert.equal(await inv.getInvoice(pm(), ids.invoice), null, 'PMs do not bill');
    assert.ok(await inv.getInvoice(coo(), ids.invoice));
    await assert.rejects(inv.updateBillingSettings(sales(), settingsBefore), /not permitted/);
    await assert.rejects(inv.draftBlank(rival(), { clientId: ids.client }), /Choose a client/);
  });

  test('a client portal login sees its issued invoices, never drafts', async () => {
    const [login] = await sql`INSERT INTO users (email, password_hash, full_name, role, client_id)
      VALUES (${`client${DOMAIN}`}, 'x', 'Client', 'client', ${ids.client}) RETURNING id`;
    const client = actor('client', Number(login.id), { clientId: ids.client });
    const draft = await inv.draftBlank(sales(), { clientId: ids.client });
    const mine = await inv.clientInvoices(client);
    assert.ok(mine.length >= 1);
    assert.ok(mine.every((i) => i.status === 'issued' || i.status === 'paid'));
    assert.equal(await inv.getClientInvoice(client, draft.invoiceId), null);
    assert.equal(await inv.getClientInvoice({ ...client, clientId: 999999 }, mine[0].id), null);
  });

  test('drafting a whole month at once skips what is already billed', async () => {
    await project('May reels', '2000.00', `${YEAR}-06`);
    const r = await inv.draftAllForPeriod(sales(), { year: YEAR, month: 6 });
    assert.deepEqual(r.drafted.map((d) => d.clientName), ['Inv Test Client']);
    const again = await inv.draftAllForPeriod(sales(), { year: YEAR, month: 6 });
    assert.deepEqual(again.drafted, []);
  });
});
