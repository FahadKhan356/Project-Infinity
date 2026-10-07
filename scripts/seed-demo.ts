/**
 * Demo seed: nine months of a fictional Dubai creative agency, for trying the
 * portal out on a laptop.
 *
 *   DATABASE_URL=postgres://… STORAGE_ROOT=/path/to/storage \
 *     node --conditions=react-server --import tsx scripts/seed-demo.ts [--reset]
 *
 * Everything that happens inside the portal happens through the portal's own
 * domain layer (src/lib/**): filing, triage, planning, resumable uploads, QA,
 * delivery, revisions, the month archive, copy-forward, time, pipeline,
 * invoices and the client portal. So statuses, notifications, activity rows
 * and files on disk are exactly what those actions produce in production.
 * Only the records the portal creates from an admin form (people, clients)
 * are written directly, mirroring those forms' server actions.
 *
 * History. The domain layer stamps now(). The seed runs as a small
 * discrete-event simulation: each scenario is an async function that says
 * `await sim.at(t)` before acting, the scheduler runs one step at a time in
 * time order, and after each step every timestamptz written by it is moved
 * to `t` (keeping the milliseconds between rows, so order is preserved).
 * The story is written around 24 September 2026 and slid to the machine's
 * date when run later: dates move by whole days, month labels by whole
 * months, so "this month" is always the busy one.
 *
 * Safety. It refuses to touch a database that already has users unless
 * --reset is given, and refuses --reset when NODE_ENV=production. --reset
 * empties every application table (keeping migrations and departments) and
 * STORAGE_ROOT/files and STORAGE_ROOT/tmp.
 *
 * Deterministic: a seeded PRNG, one step at a time, identity columns
 * restarted — two runs on the same day produce the same data.
 *
 * DEMO_TODAY=YYYY-MM-DD pretends the run happens on another day; it exists
 * to try the date slide and is not needed otherwise.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { getSql } from '../src/db';
import { loadActorById } from '../src/lib/auth/actor';
import { recordActivity } from '../src/lib/auth/audit';
import { hashPassword } from '../src/lib/auth/password';
import type { Actor, Role } from '../src/lib/authz/types';
import { saveContact, updateClientProfile, type ClientProfile } from '../src/lib/clients/profile';
import { setCostRate } from '../src/lib/costs/rates';
import { updateDelivery, type DeliveryStatus } from '../src/lib/delivery/deliveries';
import { canAttachToProject, canUploadToDeliverable } from '../src/lib/files/access';
import { appendChunk, completeUpload, createUploadSession, type CompletedUpload } from '../src/lib/files/uploads';
import {
  draftFromMonth, issueInvoice, markPaid, updateBillingSettings, voidInvoice,
} from '../src/lib/invoices/invoices';
import { copyMonth, type CopyProjectInput } from '../src/lib/months/copy';
import { closeMonth } from '../src/lib/months/lifecycle';
import {
  createOpportunity, loseOpportunity, moveOpportunity, type Stage,
} from '../src/lib/pipeline/opportunities';
import { createAssignment } from '../src/lib/planning/assign';
import { createPortalLogin } from '../src/lib/portal/access';
import { clientDecide } from '../src/lib/portal/portal';
import { DETAIL_LABELS, editProjectDetails, type ProjectDetails } from '../src/lib/projects/edit';
import { fileProject, type ProjectIntakeInput } from '../src/lib/projects/file-project';
import { formatMonth } from '../src/lib/projects/intake';
import { changeProjectStatus, type StatusChange } from '../src/lib/projects/status';
import { triageProject } from '../src/lib/projects/triage';
import { reviewDeliverable, type QaDecision } from '../src/lib/qa/review';
import { assignRevision, closeRevision, createRevision } from '../src/lib/revisions/revisions';
import { logTime } from '../src/lib/time/entries';
import { addComment } from '../src/lib/workspace/comments';

type Sql = ReturnType<typeof getSql>;
type Priority = 'low' | 'normal' | 'high' | 'urgent';
type DeptKey = 'video' | 'design' | 'development' | 'social' | 'seo';

const PASSWORD = 'Aktivacity@2026';
const RESET = process.argv.includes('--reset');
const ASSET_DIR = path.resolve(process.cwd(), 'scripts', 'demo-assets');

let sql: Sql;

/** A refusal the person running the seed can act on: printed without a stack trace. */
class SeedRefusal extends Error {}

/* ================================================================ random == */

/** mulberry32: small, fast, and the same sequence on every machine. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20260924);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const chance = (p: number) => rand() < p;

/* ================================================================== time == */

const DAY_MS = 86_400_000;
const DUBAI_MS = 4 * 3_600_000;
const BASE_TODAY = '2026-09-24';
/**
 * Now. DEMO_TODAY=YYYY-MM-DD pretends the seed runs on another day (same
 * time of day) — only for trying the date slide; leave it unset normally.
 */
const REAL_NOW = process.env.DEMO_TODAY
  ? Date.parse(`${process.env.DEMO_TODAY}T00:00:00Z`) + (((Date.now() + 4 * 3_600_000) % 86_400_000)) - 4 * 3_600_000
  : Date.now();
const REAL_TODAY = isoDay(REAL_NOW + DUBAI_MS);
/** Whole days between the day the story was written for and today. */
const SHIFT_DAYS = Math.round((Date.parse(REAL_TODAY) - Date.parse(BASE_TODAY)) / DAY_MS);
/** Month labels move by whole months, so the busy month is always the current one. */
const SHIFT_MONTHS = Math.round(SHIFT_DAYS / 30.4375);
/** Nothing is stamped later than this. */
const LATEST = REAL_NOW - 3 * 60_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  return isoDay(Date.parse(iso) + n * DAY_MS);
}
/** A calendar date of the story, moved to today's frame. */
function day(iso: string): string {
  return addDays(iso, SHIFT_DAYS);
}
/** Dubai wall-clock time on an already-shifted date. */
function atLocal(isoDate: string, hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.parse(isoDate) + (h * 60 + m) * 60_000 - DUBAI_MS);
}
/** A Dubai wall-clock moment of the story ('2026-09-14 10:30'), moved to today's frame. */
function ts(local: string): Date {
  const [d, hm = '09:00'] = local.split(' ');
  return atLocal(day(d), hm);
}
function dubaiDate(t: Date | number): string {
  return isoDay((typeof t === 'number' ? t : t.getTime()) + DUBAI_MS);
}
function dubaiMinutes(t: Date | number): number {
  const ms = (typeof t === 'number' ? t : t.getTime()) + DUBAI_MS;
  return Math.floor((((ms % DAY_MS) + DAY_MS) % DAY_MS) / 60_000);
}
function storyWeekend(storyIso: string): boolean {
  const w = new Date(`${storyIso}T00:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
}
/**
 * Whether a (slid) date was a weekend in the story's own calendar. Working
 * days are counted in the story calendar, so a run on any date replays the
 * same story shifted, rather than a slightly different one.
 */
function weekend(iso: string): boolean {
  return storyWeekend(addDays(iso, -SHIFT_DAYS));
}
function nextWorkdayDate(iso: string, n = 1): string {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (!weekend(d)) left--;
  }
  return d;
}
function hm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
/** The next working day after `t`, somewhere in [from, to] (minutes of the day). */
function nextWorkday(t: Date, from: number, to: number, n = 1): Date {
  return atLocal(nextWorkdayDate(dubaiDate(t), n), hm(int(from, to)));
}
/** `hours` of office time later: past 18:00 or on a weekend rolls to the next morning. */
function later(t: Date, hours: number): Date {
  const ms = t.getTime() + Math.round(hours * 60) * 60_000;
  const d = dubaiDate(ms);
  const min = dubaiMinutes(ms);
  if (weekend(d)) return atLocal(nextWorkdayDate(d), hm(int(9 * 60 + 10, 10 * 60 + 30)));
  if (min >= 18 * 60) return atLocal(nextWorkdayDate(d), hm(9 * 60 + 5 + ((min - 18 * 60) % 90)));
  if (min < 9 * 60) return atLocal(d, hm(9 * 60 + 10 + (min % 40)));
  return new Date(ms);
}
/** Working days of a month in the story's own calendar (before the slide). */
function baseWorkdays(y: number, m: number): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) break;
    const iso = date.toISOString().slice(0, 10);
    if (!storyWeekend(iso)) out.push(iso);
  }
  return out;
}
/** The n-th working day of a story month (negative counts from the end), as a base date. */
function wdDate(y: number, m: number, n: number): string {
  const days = baseWorkdays(y, m);
  const i = n > 0 ? Math.min(n, days.length) - 1 : Math.max(days.length + n, 0);
  return days[i];
}
function wd(y: number, m: number, n: number, time: string): Date {
  return ts(`${wdDate(y, m, n)} ${time}`);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** '24 Sep' for a story date, slid like every other date. */
function dMon(iso: string): string {
  const d = new Date(`${day(iso)}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}
/** '24 September' for a story date. */
function dMonth(iso: string): string {
  const d = new Date(`${day(iso)}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function weekday(iso: string): string {
  return new Date(`${day(iso)}T00:00:00Z`).toLocaleString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}
function nextMonth(y: number, m: number): [number, number] {
  return m === 12 ? [y + 1, 1] : [y, m + 1];
}
function prevMonth(y: number, m: number): [number, number] {
  return m === 1 ? [y - 1, 12] : [y, m - 1];
}

interface PeriodInfo {
  year: number;
  month: number;
  /** 2026-09 */
  value: string;
  /** September 2026 */
  label: string;
  /** Sep26 */
  short: string;
  /** September */
  name: string;
}
/** A story month, moved by whole months to today's frame. */
function period(y: number, m: number): PeriodInfo {
  const d = new Date(Date.UTC(y, m - 1 + SHIFT_MONTHS, 1));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const name = d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return {
    year, month, value: `${year}-${String(month).padStart(2, '0')}`,
    label: formatMonth(year, month), short: `${name.slice(0, 3)}${String(year).slice(2)}`, name,
  };
}

/* ============================================================ the clock == */

/**
 * Moves what a step wrote to the step's moment. Every timestamptz column is
 * discovered from the catalogue, so a new table cannot be forgotten.
 * `updated_at` is maintained by a trigger that would undo a rewrite, so its
 * intended values are collected here and written once at the end with the
 * trigger switched off.
 */
class Clock {
  private text = '';
  private triggerTables: { table: string; trigger: string }[] = [];
  /** table → row id → intended updated_at (timestamps come back as text: drizzle turns off the driver's parsers). */
  readonly updatedAt = new Map<string, Map<string, string>>();

  async init(): Promise<void> {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.data_type = 'timestamp with time zone'
        AND c.table_name NOT IN ('_migrations', 'sessions')
        AND c.column_name <> 'expires_at'
        AND NOT (c.table_name = 'notification_dispatches' AND c.column_name = 'next_attempt_at')
      ORDER BY c.table_name, c.ordinal_position`;
    const triggers = await sql<{ table_name: string; trigger: string }[]>`
      SELECT cl.relname AS table_name, tg.tgname AS trigger
      FROM pg_trigger tg
      JOIN pg_class cl ON cl.oid = tg.tgrelid
      JOIN pg_proc pr ON pr.oid = tg.tgfoid
      WHERE NOT tg.tgisinternal AND pr.proname = 'set_updated_at'`;
    this.triggerTables = triggers.map((t) => ({ table: t.table_name, trigger: t.trigger }));
    const triggered = new Set(triggers.map((t) => t.table_name));

    const byTable = new Map<string, string[]>();
    for (const c of cols) byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);

    // A value belongs to the step when it was written between the step's
    // start ($1) and end ($3) by the database clock; it moves to $2 plus the
    // same offset. Bounded on both sides, so rows already moved — to the past,
    // or past the machine's clock when DEMO_TODAY is ahead — stay put.
    const S = '$1::timestamptz';
    const W = '$2::timestamptz';
    const E = '$3::timestamptz';
    const inStep = (c: string) => `${c} BETWEEN ${S} AND ${E}`;
    const shift = (c: string) => `CASE WHEN ${inStep(c)} THEN ${W} + (${c} - ${S}) ELSE ${c} END`;
    const ctes: string[] = [];
    const selects: string[] = [];
    let i = 0;
    for (const [table, columns] of byTable) {
      const name = `u${i++}`;
      if (triggered.has(table) && columns.includes('updated_at')) {
        const others = columns.filter((c) => c !== 'updated_at');
        const any = columns.map((c) => inStep(`x."${c}"`)).join(' OR ');
        ctes.push(`${name} AS (
          UPDATE "${table}" t SET ${others.map((c) => `"${c}" = ${shift(`t."${c}"`)}`).join(', ')}
          FROM (SELECT x.id AS _id, x.updated_at AS _u FROM "${table}" x WHERE ${any}) o
          WHERE t.id = o._id
          RETURNING '${table}'::text AS tbl, t.id::text AS id, ${shift('o._u')} AS nu)`);
        selects.push(`SELECT tbl, id, nu FROM ${name}`);
      } else {
        ctes.push(`${name} AS (
          UPDATE "${table}" t SET ${columns.map((c) => `"${c}" = ${shift(`t."${c}"`)}`).join(', ')}
          WHERE ${columns.map((c) => inStep(`t."${c}"`)).join(' OR ')}
          RETURNING 1)`);
      }
    }
    this.text = `WITH ${ctes.join(',\n')}\n${selects.join('\nUNION ALL\n')}`;
  }

  async mark(): Promise<string> {
    const [row] = await sql<{ t: string }[]>`SELECT clock_timestamp()::text AS t`;
    return row.t;
  }

  async rewrite(start: string, when: Date): Promise<void> {
    const end = await this.mark();
    const rows = await sql.unsafe<{ tbl: string; id: string; nu: string }[]>(this.text, [start, when.toISOString(), end]);
    for (const r of rows) {
      let table = this.updatedAt.get(r.tbl);
      if (!table) this.updatedAt.set(r.tbl, (table = new Map()));
      table.set(r.id, r.nu);
    }
  }

  /** Runs `fn` as if at `when`, outside the scheduler (the time-sheet pass). */
  async stamp<T>(when: Date, fn: () => Promise<T>): Promise<T> {
    const start = await this.mark();
    await pause();
    const result = await fn();
    await this.rewrite(start, when);
    return result;
  }

  /** Writes the collected updated_at values, with the trigger that would overwrite them off. */
  async settle(): Promise<void> {
    for (const { table, trigger } of this.triggerTables) {
      const values = this.updatedAt.get(table);
      await sql.begin(async (tx) => {
        await tx.unsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
        if (table === 'upload_sessions') {
          await tx.unsafe(`UPDATE upload_sessions SET expires_at = created_at + interval '24 hours'`);
        }
        if (values && values.size > 0) {
          await tx.unsafe(
            `UPDATE "${table}" t SET updated_at = v.u
             FROM json_to_recordset($1::json) AS v(id text, u timestamptz) WHERE t.id::text = v.id`,
            [JSON.stringify([...values].map(([id, u]) => ({ id, u })))],
          );
        }
        await tx.unsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
      });
    }
  }
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

/* ======================================================== the scheduler == */

interface Waiter { t: number; seq: number; label: string; go: () => void }

/**
 * One step at a time, in time order. A scenario is a coroutine: it runs
 * until it awaits `sim.at(t)`, and resumes when every earlier step is done.
 */
class Sim {
  private heap: Waiter[] = [];
  private seq = 0;
  private yielded: (() => void) | null = null;
  private failure: Error | null = null;
  private lastEnd = 0;
  now = 0;
  steps = 0;
  readonly late: string[] = [];

  constructor(private clock: Clock) {}

  /** Starts a coroutine at `t`. */
  spawn(t: Date, label: string, fn: () => Promise<void>): void {
    this.push(t.getTime(), label, () => {
      void (async () => {
        try {
          await fn();
        } catch (error) {
          const e = error instanceof Error ? error : new Error(String(error));
          e.message = `[${label} @ ${new Date(this.now).toISOString()}] ${e.message}`;
          this.failure ??= e;
        } finally {
          this.release();
        }
      })();
    });
  }

  /** Waits until `t`; what follows happens at `t`. */
  at(t: Date, label = ''): Promise<void> {
    if (t.getTime() < this.now - 60_000) this.late.push(`${label || 'step'} asked for ${t.toISOString()} at ${new Date(this.now).toISOString()}`);
    return new Promise<void>((resolve) => {
      this.push(t.getTime(), label, resolve);
      this.release();
    });
  }

  date(): Date {
    return new Date(this.now);
  }

  today(): string {
    return dubaiDate(this.now);
  }

  async run(progress?: (t: number) => void): Promise<void> {
    while (this.heap.length > 0) {
      const w = this.pop();
      const t = Math.max(Math.min(w.t, LATEST), this.lastEnd + 1000);
      this.now = t;
      const start = await this.clock.mark();
      const startedAt = Date.now();
      await pause();
      const done = new Promise<void>((resolve) => { this.yielded = resolve; });
      w.go();
      await done;
      if (this.failure) throw this.failure;
      await this.clock.rewrite(start, new Date(t));
      this.lastEnd = t + (Date.now() - startedAt);
      this.steps++;
      progress?.(t);
    }
  }

  private release(): void {
    const y = this.yielded;
    this.yielded = null;
    y?.();
  }

  private push(t: number, label: string, go: () => void): void {
    const h = this.heap;
    h.push({ t, seq: this.seq++, label, go });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(h[p], h[i])) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }

  private pop(): Waiter {
    const h = this.heap;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }

  private less(a: Waiter, b: Waiter): boolean {
    return a.t < b.t || (a.t === b.t && a.seq < b.seq);
  }
}

let clock: Clock;
let sim: Sim;

/* ================================================================ files == */

interface Blob { name: string; bytes: Buffer; mime: string }
const assets = new Map<string, Buffer>();

async function loadAssets(): Promise<void> {
  if (!existsSync(ASSET_DIR)) {
    throw new SeedRefusal(`Cannot find ${ASSET_DIR}. Run the seed from the repository root.`);
  }
  for (const f of await readdir(ASSET_DIR)) assets.set(f, await readFile(path.join(ASSET_DIR, f)));
}

function asset(file: string, name: string): Blob {
  const bytes = assets.get(file);
  if (!bytes) throw new Error(`Missing demo asset ${file}`);
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'mp4' ? 'video/mp4' : ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
  return { name: `${name}.${ext === 'jpeg' ? 'jpg' : ext}`, bytes, mime };
}

/* ----- a small PDF writer: real text, valid cross-reference table ------- */

type PdfBlock =
  | { h: string }
  | { p: string }
  | { li: string }
  | { row: string[] }
  | { gap: number };
interface PdfDoc {
  title: string;
  subtitle?: string;
  accent?: [number, number, number];
  meta?: [string, string][];
  blocks: PdfBlock[];
  footer?: string;
}

function ascii(s: string): string {
  return s
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/×/g, 'x')
    .replace(/[^\x20-\x7E]/g, '');
}
function esc(s: string): string {
  return ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of ascii(text).split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

function makePdf(doc: PdfDoc): Blob['bytes'] {
  const [r, g, b] = (doc.accent ?? [18, 44, 90]).map((c) => (c / 255).toFixed(3));
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = 0;
  const text = (font: 'F1' | 'F2', size: number, x: number, yy: number, s: string, color = '0.15 0.15 0.18') =>
    ops.push(`BT /${font} ${size} Tf ${color} rg ${x} ${yy} Td (${esc(s)}) Tj ET`);
  const newPage = (first: boolean) => {
    if (ops.length) pages.push(ops);
    ops = [];
    if (first) {
      ops.push(`${r} ${g} ${b} rg 0 762 595 80 re f`);
      text('F2', 20, 40, 806, doc.title, '1 1 1');
      if (doc.subtitle) text('F1', 11, 40, 784, doc.subtitle, '0.9 0.92 0.96');
      y = 736;
    } else {
      y = 800;
    }
  };
  const need = (h: number) => {
    if (y - h < 64) newPage(false);
  };
  newPage(true);
  for (const [label, value] of doc.meta ?? []) {
    need(16);
    text('F2', 10, 40, y, `${label}:`);
    text('F1', 10, 150, y, value);
    y -= 15;
  }
  if (doc.meta?.length) {
    ops.push(`0.8 0.82 0.86 RG 0.6 w 40 ${y + 4} m 555 ${y + 4} l S`);
    y -= 14;
  }
  for (const block of doc.blocks) {
    if ('gap' in block) {
      y -= block.gap;
    } else if ('h' in block) {
      need(30);
      y -= 6;
      text('F2', 13, 40, y, block.h, `${r} ${g} ${b}`);
      y -= 20;
    } else if ('p' in block) {
      for (const line of wrapText(block.p, 92)) {
        need(14);
        text('F1', 10.5, 40, y, line);
        y -= 14;
      }
      y -= 6;
    } else if ('li' in block) {
      wrapText(block.li, 86).forEach((line, i) => {
        need(14);
        if (i === 0) text('F1', 10.5, 46, y, '-');
        text('F1', 10.5, 58, y, line);
        y -= 14;
      });
    } else {
      need(15);
      const xs = [40, 250, 360, 460];
      block.row.forEach((cell, i) => text('F1', 10, xs[i] ?? 40 + i * 110, y, cell));
      y -= 15;
    }
  }
  pages.push(ops);

  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1 catalog, 2 pages, 3 F1, 4 F2, 5 info; then page/content pairs.
  const total = pages.length;
  pages.forEach((pageOps, i) => {
    const footer = `BT /F1 8.5 Tf 0.45 0.47 0.52 rg 40 32 Td (${esc(`${doc.footer ?? 'Aktivacity FZ-LLC | Dubai Media City'} | Page ${i + 1} of ${total}`)}) Tj ET`;
    const stream = [...pageOps, footer].join('\n');
    const pageId = 6 + i * 2;
    pageIds.push(pageId);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${total} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = `<< /Title (${esc(doc.title)}) /Producer (Aktivacity portal demo seed) >>`;

  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(body, 'latin1');
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function pdf(name: string, doc: PdfDoc): Blob {
  return { name: `${name}.pdf`, bytes: makePdf(doc), mime: 'application/pdf' };
}

/* =============================================================== people == */

interface Person {
  key: string;
  email: string;
  name: string;
  role: Role;
  dept?: DeptKey | 'sales' | 'pm' | 'management';
  lead?: boolean;
  joined?: string;
  leaves?: string;
  rate?: number;
}

const PEOPLE: Person[] = [
  { key: 'admin', email: 'admin@aktivacity.local', name: 'Portal Administrator', role: 'admin', dept: 'management' },
  { key: 'ceo', email: 'ceo@aktivacity.local', name: 'Khalid Al Mansoori', role: 'ceo', dept: 'management' },
  { key: 'coo', email: 'coo@aktivacity.local', name: 'Priya Raman', role: 'coo', dept: 'management' },
  { key: 'omar', email: 'sales@aktivacity.local', name: 'Omar Haddad', role: 'sales', dept: 'sales' },
  { key: 'lina', email: 'lina.farouk@aktivacity.local', name: 'Lina Farouk', role: 'sales', dept: 'sales' },
  { key: 'daniel', email: 'pm@aktivacity.local', name: 'Daniel Reyes', role: 'project_manager', dept: 'pm' },
  { key: 'fatima', email: 'fatima.noor@aktivacity.local', name: 'Fatima Noor', role: 'project_manager', dept: 'pm' },
  { key: 'hassan', email: 'video.lead@aktivacity.local', name: 'Hassan Qureshi', role: 'team_lead', dept: 'video', lead: true, rate: 150 },
  { key: 'maya', email: 'design.lead@aktivacity.local', name: 'Maya Chen', role: 'team_lead', dept: 'design', lead: true, rate: 140 },
  { key: 'arjun', email: 'dev.lead@aktivacity.local', name: 'Arjun Mehta', role: 'team_lead', dept: 'development', lead: true, rate: 165 },
  { key: 'nour', email: 'social.lead@aktivacity.local', name: 'Nour El-Sayed', role: 'team_lead', dept: 'social', lead: true, rate: 120 },
  { key: 'rachel', email: 'seo.lead@aktivacity.local', name: 'Rachel Adams', role: 'team_lead', dept: 'seo', lead: true, rate: 130 },
  { key: 'ahmed', email: 'ahmed@aktivacity.local', name: 'Ahmed Karim', role: 'executive', dept: 'video', rate: 75 },
  { key: 'yusuf', email: 'yusuf.rahman@aktivacity.local', name: 'Yusuf Rahman', role: 'executive', dept: 'video', rate: 70 },
  { key: 'bilal', email: 'bilal.sheikh@aktivacity.local', name: 'Bilal Sheikh', role: 'executive', dept: 'video', rate: 65 },
  { key: 'sara', email: 'sara.ali@aktivacity.local', name: 'Sara Ali', role: 'executive', dept: 'design', rate: 70 },
  { key: 'zainab', email: 'zainab.hussain@aktivacity.local', name: 'Zainab Hussain', role: 'executive', dept: 'design', rate: 65 },
  { key: 'tom', email: 'tom.becker@aktivacity.local', name: 'Tom Becker', role: 'executive', dept: 'design', rate: 60 },
  { key: 'kevin', email: 'kevin.dsouza@aktivacity.local', name: 'Kevin D’Souza', role: 'executive', dept: 'development', rate: 95 },
  { key: 'rohan', email: 'rohan.iyer@aktivacity.local', name: 'Rohan Iyer', role: 'executive', dept: 'development', rate: 80, joined: '2026-06-01' },
  { key: 'aisha', email: 'aisha.malik@aktivacity.local', name: 'Aisha Malik', role: 'executive', dept: 'social', rate: 55 },
  { key: 'layla', email: 'layla.mansour@aktivacity.local', name: 'Layla Mansour', role: 'executive', dept: 'social', rate: 50, joined: '2026-05-04' },
  { key: 'imran', email: 'imran.khan@aktivacity.local', name: 'Imran Khan', role: 'executive', dept: 'seo', rate: 65 },
  { key: 'hannah', email: 'hannah.brooks@aktivacity.local', name: 'Hannah Brooks', role: 'executive', dept: 'seo', rate: 60 },
  { key: 'james', email: 'james.whitfield@aktivacity.local', name: 'James Whitfield', role: 'executive', dept: 'design', rate: 62, leaves: '2026-04-10' },
];

const LEAD: Record<DeptKey, string> = { video: 'hassan', design: 'maya', development: 'arjun', social: 'nour', seo: 'rachel' };
const DEPT: Record<string, number> = {};
const ID: Record<string, number> = {};
const actors = new Map<string, Actor>();

function actor(key: string): Actor {
  const a = actors.get(key);
  if (!a) throw new Error(`No actor loaded for ${key}`);
  return a;
}
async function loadActor(key: string): Promise<Actor> {
  const a = await loadActorById(ID[key]);
  if (!a) throw new Error(`Cannot load ${key}`);
  actors.set(key, a);
  return a;
}

/* ============================================================== registry == */

type ClientKey = 'alnoor' | 'desertbloom' | 'gulf' | 'falcon' | 'oasis' | 'summit' | 'marina' | 'nimbus'
  | 'palmgrove' | 'crescent' | 'qasr' | 'padel' | 'aktivacity';

interface ProjectRec {
  key: string;
  id: number;
  code: string;
  client: ClientKey;
  sales: string;
  pm: string;
  requiresPmQa: boolean;
  y: number;
  m: number;
}
interface SlotRec { id: number; name: string; seq: number; dept: DeptKey; assignee: string; project: string }
interface WorkWindow {
  assignmentId: number; projectId: number; user: string; dept: DeptKey;
  start: string; end: string; closedOn: string | null; weight: number;
}

const reg = {
  clients: new Map<ClientKey, number>(),
  months: new Map<string, number>(),
  projects: new Map<string, ProjectRec>(),
  slots: new Map<string, SlotRec>(),
  deliveries: new Map<number, number>(),
  opps: new Map<string, number>(),
  invoices: new Map<string, number>(),
  work: [] as WorkWindow[],
};
const monthKey = (c: ClientKey, y: number, m: number) => `${c}:${y}-${m}`;
function project(key: string): ProjectRec {
  const p = reg.projects.get(key);
  if (!p) throw new Error(`Project ${key} has not been filed yet`);
  return p;
}
function slot(projectKey: string, dept: DeptKey, seq: number): SlotRec {
  const s = reg.slots.get(`${projectKey}:${dept}:${seq}`);
  if (!s) throw new Error(`No slot ${dept} ${seq} on ${projectKey}`);
  return s;
}
function deliveryOf(slotId: number): number {
  const d = reg.deliveries.get(slotId);
  if (!d) throw new Error(`No delivery for deliverable ${slotId}`);
  return d;
}

/* ======================================== actions, as the portal takes them ==
 * Each wrapper calls the domain function and then writes the activity row
 * the corresponding server action or route handler writes.
 */

const A = {
  async fileProject(who: Actor, input: ProjectIntakeInput) {
    const r = await fileProject(who, input);
    await recordActivity({
      actorId: who.id, action: 'project.created', entityType: 'project', entityId: r.projectId,
      projectId: r.projectId, metadata: { projectCode: r.projectCode, monthCreated: r.monthCreated },
    });
    if (input.opportunityId) {
      await recordActivity({
        actorId: who.id, action: 'opportunity.won', entityType: 'opportunity', entityId: input.opportunityId,
        projectId: r.projectId, metadata: { projectCode: r.projectCode },
      });
    }
    return r;
  },

  async triage(who: Actor, input: Parameters<typeof triageProject>[1]) {
    const r = await triageProject(who, input);
    const routed = await sql<{ name: string }[]>`
      SELECT d.name FROM project_departments pd JOIN departments d ON d.id = pd.department_id
      WHERE pd.project_id = ${r.projectId} AND pd.team_lead_id IS NOT NULL ORDER BY d.sort_order`;
    await recordActivity({
      actorId: who.id, action: 'project.triaged', entityType: 'project', entityId: r.projectId, projectId: r.projectId,
      metadata: { status: r.status, assignedTeams: r.assignedTeams, totalTeams: r.totalTeams, teams: routed.map((x) => x.name) },
    });
    return r;
  },

  async assign(who: Actor, input: Parameters<typeof createAssignment>[1]) {
    const r = await createAssignment(who, input);
    const [assignee] = await sql<{ full_name: string }[]>`SELECT full_name FROM users WHERE id = ${input.assigneeId}`;
    await recordActivity({
      actorId: who.id, action: 'assignment.created', entityType: 'assignment', entityId: r.assignmentId, projectId: r.projectId,
      metadata: {
        assigneeId: input.assigneeId, assigneeName: assignee?.full_name ?? null, deliverables: r.deliverableIds.length,
        sequenceRange: r.firstSequenceNo === null ? null : `${r.firstSequenceNo}-${r.lastSequenceNo}`,
      },
    });
    return r;
  },

  async upload(who: Actor, deliverableId: number, file: Blob, notes: string | null = null): Promise<CompletedUpload> {
    const decision = await canUploadToDeliverable(who, deliverableId);
    if (!decision.allowed) throw new Error(`${who.fullName} may not upload to deliverable ${deliverableId}: ${decision.reason}`);
    const { session } = await createUploadSession(who, {
      target: 'deliverable', deliverableId, projectId: decision.projectId, purpose: null,
      filename: file.name, size: file.bytes.length, mimeType: file.mime, checksum: null, notes,
    });
    await recordActivity({
      actorId: who.id, action: 'file.upload_started', entityType: 'deliverable', entityId: deliverableId,
      projectId: decision.projectId ?? null, metadata: { uploadId: session.id, filename: file.name, size: file.bytes.length },
    });
    await appendChunk(who, session.id, 0, streamOf(file.bytes));
    const r = await completeUpload(who, session.id);
    await logUploaded(who, session.id, r);
    return r;
  },

  async attach(
    who: Actor,
    target: { projectId: number; assignmentId?: number; revisionId?: number; purpose?: string; kind?: 'po' | 'reference' },
    file: Blob,
  ): Promise<CompletedUpload> {
    const decision = await canAttachToProject(who, target.projectId, {
      assignmentId: target.assignmentId, revisionId: target.revisionId, kind: target.kind,
    });
    if (!decision.allowed) throw new Error(`${who.fullName} may not attach to project ${target.projectId}: ${decision.reason}`);
    const { session } = await createUploadSession(who, {
      target: 'attachment', projectId: target.projectId, assignmentId: target.assignmentId, revisionId: target.revisionId,
      purpose: target.purpose ?? null, kind: target.kind, filename: file.name, size: file.bytes.length, mimeType: file.mime, checksum: null, notes: null,
    });
    await recordActivity({
      actorId: who.id, action: 'file.upload_started', entityType: 'attachment', entityId: target.projectId,
      projectId: target.projectId, metadata: { uploadId: session.id, filename: file.name, size: file.bytes.length },
    });
    await appendChunk(who, session.id, 0, streamOf(file.bytes));
    const r = await completeUpload(who, session.id);
    await logUploaded(who, session.id, r);
    return r;
  },

  async review(who: Actor, deliverableId: number, decision: QaDecision, comments: string | null) {
    // reviewDeliverable writes the qa.reviewed record itself, inside its transaction.
    const r = await reviewDeliverable(who, { deliverableId, decision, comments });
    if (r.deliveryId !== null) reg.deliveries.set(r.deliverableId, r.deliveryId);
    await noteAssignmentState(deliverableId);
    return r;
  },

  async delivery(who: Actor, deliveryId: number, status: DeliveryStatus, extra: { notes?: string; clientFeedback?: string } = {}) {
    const r = await updateDelivery(who, { deliveryId, status, notes: extra.notes, clientFeedback: extra.clientFeedback });
    await recordActivity({
      actorId: who.id, action: 'delivery.updated', entityType: 'delivery', entityId: r.deliveryId, projectId: r.projectId,
      metadata: { status: r.status, deliverableId: r.deliverableId, deliverableName: r.deliverableName, projectStatus: r.projectStatus },
    });
    return r;
  },

  async clientDecision(who: Actor, deliveryId: number, decision: 'approved' | 'changes_requested', feedback: string | null = null) {
    const r = await clientDecide(who, { deliveryId, decision, feedback });
    await recordActivity({
      actorId: who.id, action: 'delivery.client_decision', entityType: 'delivery', entityId: deliveryId,
      projectId: r.projectId, clientId: who.clientId ?? null, metadata: { decision, deliverableName: r.deliverableName },
    });
    return r;
  },

  async openRevision(who: Actor, input: Parameters<typeof createRevision>[1]) {
    const r = await createRevision(who, input);
    await recordActivity({
      actorId: who.id, action: 'revision.created', entityType: 'revision', entityId: r.revisionId, projectId: r.projectId,
      metadata: { revisionNo: r.revisionNo, title: input.title.trim(), deliverableIds: r.deliverableIds, projectStatus: r.projectStatus },
    });
    return r;
  },

  async handRevision(who: Actor, revisionId: number, deliverableId: number, assignee: string, deadline: string | null) {
    const r = await assignRevision(who, { revisionId, deliverableId, assigneeId: ID[assignee] });
    await recordActivity({
      actorId: who.id, action: 'revision.assigned', entityType: 'revision', entityId: r.revisionId, projectId: r.projectId,
      metadata: {
        revisionNo: r.revisionNo, deliverableId: r.deliverableId, deliverableName: r.deliverableName,
        assigneeId: ID[assignee], assigneeName: actor(assignee).fullName, assignmentId: r.assignmentId, assignmentCreated: r.created,
      },
    });
    if (r.created) {
      // assignRevision dates a new assignment from the database's today; in
      // the story it was handed out today.
      await sql`UPDATE assignments SET start_date = ${sim.today()} WHERE id = ${r.assignmentId}`;
      const dept = await deptOfAssignment(r.assignmentId);
      reg.work.push({
        assignmentId: r.assignmentId, projectId: r.projectId, user: assignee, dept,
        start: sim.today(), end: deadline ?? nextWorkdayDate(sim.today(), 3), closedOn: null, weight: 1,
      });
    } else {
      const w = reg.work.find((x) => x.assignmentId === r.assignmentId);
      if (w) {
        w.closedOn = null;
        if (deadline && deadline > w.end) w.end = deadline;
      }
    }
    return r;
  },

  async endRevision(who: Actor, revisionId: number, outcome: 'closed' | 'cancelled') {
    const r = await closeRevision(who, { revisionId, outcome });
    await recordActivity({
      actorId: who.id, action: 'revision.closed', entityType: 'revision', entityId: r.revisionId, projectId: r.projectId,
      metadata: { revisionNo: r.revisionNo, status: r.status, projectStatus: r.projectStatus },
    });
    return r;
  },

  async comment(who: Actor, target: { projectId?: number; deliverableId?: number; revisionId?: number }, body: string) {
    const r = await addComment(who, { ...target, body });
    await recordActivity({
      actorId: who.id, action: 'comment.posted', entityType: 'comment', entityId: r.commentId, projectId: r.projectId,
      metadata: target.revisionId !== undefined ? { revisionId: target.revisionId }
        : target.deliverableId !== undefined ? { deliverableId: target.deliverableId } : {},
    });
    return r;
  },

  async status(who: Actor, projectId: number, change: StatusChange, reason: string | null) {
    const r = await changeProjectStatus(who, { projectId, change, reason });
    await recordActivity({
      actorId: who.id, action: 'project.status_changed', entityType: 'project', entityId: projectId, projectId,
      metadata: {
        change, reason, from: r.from, status: r.status,
        cancelledSlots: r.cancelledSlots, cancelledAssignments: r.cancelledAssignments,
      },
    });
    if (change !== 'resume') {
      for (const w of reg.work) if (w.projectId === projectId && !w.closedOn) w.closedOn = sim.today();
    }
    return r;
  },

  async editDetails(who: Actor, projectId: number, patch: Partial<ProjectDetails>) {
    const [row] = await sql<{
      title: string; project_type: string | null; objective: string | null; description: string | null;
      po_reference: string | null; requirements: string | null; client_notes: string | null;
      other_info: string | null; price_amount: string | null; recurs_monthly: boolean;
    }[]>`SELECT title, project_type, objective, description, po_reference, requirements, client_notes,
                other_info, price_amount::text AS price_amount, recurs_monthly FROM projects WHERE id = ${projectId}`;
    const details: ProjectDetails = {
      title: row.title, projectType: row.project_type, objective: row.objective, description: row.description,
      poReference: row.po_reference, requirements: row.requirements, clientNotes: row.client_notes,
      otherInfo: row.other_info, priceAmount: row.price_amount, recursMonthly: row.recurs_monthly, ...patch,
    };
    const r = await editProjectDetails(who, { projectId, details });
    if (r.changed.length > 0) {
      await recordActivity({
        actorId: who.id, action: 'project.details_edited', entityType: 'project', entityId: projectId, projectId,
        metadata: { fields: r.changed.map((k) => DETAIL_LABELS[k]) },
      });
    }
    return r;
  },

  async closeMonth(who: Actor, clientMonthId: number) {
    const r = await closeMonth(who, { clientMonthId });
    await recordActivity({
      actorId: who.id, action: 'client.month_closed', entityType: 'client_month', entityId: r.clientMonthId,
      clientId: r.clientId, metadata: { year: r.year, month: r.month, projectCount: r.projectCount },
    });
    return r;
  },

  async copyMonth(who: Actor, input: Parameters<typeof copyMonth>[1]) {
    const r = await copyMonth(who, input);
    const [from] = await sql<{ period_year: number; period_month: number }[]>`
      SELECT period_year, period_month FROM client_months WHERE id = ${input.fromMonthId}`;
    await recordActivity({
      actorId: who.id, action: 'client.month_copied', entityType: 'client_month', entityId: r.clientMonthId, clientId: r.clientId,
      metadata: {
        year: r.year, month: r.month, fromLabel: formatMonth(Number(from.period_year), Number(from.period_month)),
        projectCount: r.projects.length, monthCreated: r.monthCreated, projectCodes: r.projects.map((p) => p.projectCode),
      },
    });
    for (const p of r.projects) {
      await recordActivity({
        actorId: who.id, action: 'project.created', entityType: 'project', entityId: p.projectId, projectId: p.projectId,
        clientId: r.clientId, metadata: { projectCode: p.projectCode, copiedFromCode: p.copiedFromCode, copiedFromId: p.copiedFromId },
      });
    }
    return r;
  },

  /** "Open next month" on the client page (brief §37). */
  async openMonth(who: Actor, client: ClientKey, y: number, m: number) {
    const clientId = reg.clients.get(client)!;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO client_months (client_id, period_year, period_month, created_by)
      VALUES (${clientId}, ${y}, ${m}, ${who.id})
      ON CONFLICT (client_id, period_year, period_month) DO UPDATE SET client_id = EXCLUDED.client_id
      RETURNING id`;
    // Recorded against the month, as createNextMonth does, so the month view lists it.
    await recordActivity({
      actorId: who.id, action: 'client.month_opened', entityType: 'client_month', entityId: Number(row.id), clientId,
      metadata: { year: y, month: m },
    });
    return Number(row.id);
  },

  async opportunity(who: Actor, input: Parameters<typeof createOpportunity>[1]) {
    const r = await createOpportunity(who, input);
    await recordActivity({
      actorId: who.id, action: 'opportunity.created', entityType: 'opportunity', entityId: r.id,
      clientId: input.clientId, metadata: { title: input.title },
    });
    return r.id;
  },

  async stage(who: Actor, id: number, stage: Stage) {
    const r = await moveOpportunity(who, { id, stage });
    await recordActivity({
      actorId: who.id, action: 'opportunity.stage_changed', entityType: 'opportunity', entityId: id,
      clientId: r.clientId, metadata: { stage },
    });
  },

  async lost(who: Actor, id: number, reason: string) {
    const r = await loseOpportunity(who, { id, reason });
    await recordActivity({
      actorId: who.id, action: 'opportunity.lost', entityType: 'opportunity', entityId: id,
      clientId: r.clientId, metadata: { reason: reason.trim().slice(0, 200) },
    });
  },

  async draftInvoice(who: Actor, clientMonthId: number) {
    const r = await draftFromMonth(who, { clientMonthId });
    await recordActivity({ actorId: who.id, action: 'invoice.drafted', entityType: 'invoice', entityId: r.invoiceId, metadata: {} });
    return r.invoiceId;
  },

  async issue(who: Actor, invoiceId: number) {
    const r = await issueInvoice(who, invoiceId, sim.date());
    await recordActivity({ actorId: who.id, action: 'invoice.issued', entityType: 'invoice', entityId: invoiceId, metadata: { invoiceNo: r.invoiceNo } });
    return r.invoiceNo;
  },

  async paid(who: Actor, invoiceId: number, paidOn: string) {
    await markPaid(who, { invoiceId, paidOn });
    await recordActivity({ actorId: who.id, action: 'invoice.paid', entityType: 'invoice', entityId: invoiceId, metadata: { paidOn } });
  },

  async void(who: Actor, invoiceId: number, reason: string) {
    await voidInvoice(who, { invoiceId, reason });
    await recordActivity({ actorId: who.id, action: 'invoice.voided', entityType: 'invoice', entityId: invoiceId, metadata: { reason: reason.slice(0, 200) } });
  },
};

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function logUploaded(who: Actor, uploadId: string, r: CompletedUpload): Promise<void> {
  await recordActivity({
    actorId: who.id, action: 'file.uploaded', entityType: 'file', entityId: r.fileId, projectId: r.projectId,
    metadata: {
      uploadId, deliverableId: r.deliverableId, deliverableName: r.deliverableName, versionNo: r.versionNo,
      revisionNo: r.revisionNo, filename: r.originalFilename, assignmentTitle: r.assignmentTitle, kind: r.kind,
      sizeBytes: r.sizeBytes, checksum: r.checksum,
    },
  });
}

async function deptOfAssignment(assignmentId: number): Promise<DeptKey> {
  const [row] = await sql<{ slug: DeptKey }[]>`
    SELECT d.slug FROM assignments a JOIN project_departments pd ON pd.id = a.project_department_id
    JOIN departments d ON d.id = pd.department_id WHERE a.id = ${assignmentId}`;
  return row.slug;
}

/** Remembers when an assignment was signed off, so the time sheets stop there. */
async function noteAssignmentState(deliverableId: number): Promise<void> {
  const [row] = await sql<{ id: string; status: string }[]>`
    SELECT a.id, a.status FROM deliverables d JOIN assignments a ON a.id = d.assignment_id WHERE d.id = ${deliverableId}`;
  if (!row) return;
  const w = reg.work.find((x) => x.assignmentId === Number(row.id));
  if (!w) return;
  if (row.status === 'completed' && !w.closedOn) w.closedOn = sim.today();
  if (row.status !== 'completed' && w.closedOn) w.closedOn = null;
}

/* ================================================================ clients == */

interface ClientSeed {
  key: ClientKey;
  name: string;
  company: string;
  type: 'retainer' | 'one_off';
  /** Who books the client; the CEO books the agency's own work. */
  owner: 'omar' | 'lina' | 'ceo';
  prospect: boolean;
  created: string;
  startedOn?: string;
  services: DeptKey[];
  notes: string;
  contacts: { name: string; email: string; phone: string; title: string; primary?: boolean }[];
  code: string;
}

const CLIENTS: ClientSeed[] = [
  {
    key: 'alnoor', name: 'Al Noor Real Estate', company: 'Al Noor Real Estate Development LLC', type: 'retainer', owner: 'omar',
    prospect: false, created: '2026-01-02 10:20', startedOn: '2026-01-04', code: 'AlNoor',
    services: ['video', 'design', 'development', 'social', 'seo'],
    notes: 'Premium residential developer (Dubai Marina, Dubai Hills, JVC). Full-service retainer since January: monthly social video, social design, SEO and community management, plus website updates as needed. All cuts are approved by Mariam; brand guidelines v3 (March 2026) apply — gold lockup, RERA permit number on every property ad. Arabic and English captions on everything.',
    contacts: [
      { name: 'Mariam Al Suwaidi', email: 'mariam.alsuwaidi@alnoor-realestate.example', phone: '+971 4 555 0142', title: 'Marketing Director', primary: true },
      { name: 'Faisal Rahman', email: 'faisal.rahman@alnoor-realestate.example', phone: '+971 50 555 3187', title: 'Digital Marketing Manager' },
      { name: 'Accounts Payable', email: 'ap@alnoor-realestate.example', phone: '+971 4 555 0100', title: 'Finance' },
    ],
  },
  {
    key: 'oasis', name: 'Oasis Dental Clinics', company: 'Oasis Dental Care LLC', type: 'retainer', owner: 'lina',
    prospect: true, created: '2026-02-09 11:05', startedOn: '2026-03-01', code: 'Oasis',
    services: ['seo', 'social', 'design'],
    notes: 'Three clinics (Jumeirah, Al Barsha, Mirdif). Local SEO + social retainer from March. DHA advertising rules: no before/after photos without consent forms, no price guarantees. Dr. Leena Haddad signs off medical claims.',
    contacts: [
      { name: 'Dr. Leena Haddad', email: 'leena.haddad@oasisdental.example', phone: '+971 4 555 2210', title: 'Medical Director', primary: true },
      { name: 'Joanna Pereira', email: 'marketing@oasisdental.example', phone: '+971 55 555 7741', title: 'Practice Marketing Coordinator' },
    ],
  },
  {
    key: 'desertbloom', name: 'Desert Bloom Cafés', company: 'Desert Bloom Hospitality LLC', type: 'retainer', owner: 'lina',
    prospect: true, created: '2026-04-06 14:30', startedOn: '2026-05-01', code: 'DesertBloom',
    services: ['social', 'design', 'video'],
    notes: 'Specialty coffee chain, six cafés across Dubai. Social media management, menu/promo design and café reels from May. Tone: warm, playful, never salesy. Seasonal menu launches drive the calendar.',
    contacts: [
      { name: 'Rania Khoury', email: 'rania@desertbloom.example', phone: '+971 50 555 9024', title: 'Brand Manager', primary: true },
      { name: 'Sameer Aziz', email: 'sameer.aziz@desertbloom.example', phone: '+971 4 555 6630', title: 'Operations Director' },
    ],
  },
  {
    key: 'gulf', name: 'Gulf Horizon Hotels', company: 'Gulf Horizon Hotels & Resorts', type: 'one_off', owner: 'omar',
    prospect: true, created: '2026-07-20 12:10', startedOn: '2026-08-03', code: 'GulfHorizon',
    services: ['video', 'design', 'seo', 'social'],
    notes: 'Four-property hotel group (JBR, Palm, Hatta, Ras Al Khaimah). Project-based: the 2026 brand film in August, seasonal campaigns since. Approvals through Nadia in marketing; legal checks all offers.',
    contacts: [
      { name: 'Nadia Farouk', email: 'nadia.farouk@gulfhorizonhotels.example', phone: '+971 4 555 4812', title: 'Director of Marketing', primary: true },
      { name: 'Chris Walker', email: 'chris.walker@gulfhorizonhotels.example', phone: '+971 56 555 2093', title: 'E-commerce Manager' },
    ],
  },
  {
    key: 'falcon', name: 'Falcon Logistics', company: 'Falcon Logistics FZE', type: 'one_off', owner: 'lina',
    prospect: true, created: '2026-07-08 10:40', startedOn: '2026-09-01', code: 'Falcon',
    services: ['development', 'design', 'seo'],
    notes: 'Freight forwarder in JAFZA. Corporate website rebuild won in August: new design system, CMS, shipment-tracking widget against their TMS API, quote forms, full SEO migration. IT contact controls DNS and the staging server.',
    contacts: [
      { name: 'Vikram Nair', email: 'vikram.nair@falconlogistics.example', phone: '+971 4 555 7719', title: 'Head of Marketing', primary: true },
      { name: 'Ahmed Saleh', email: 'it@falconlogistics.example', phone: '+971 4 555 7700', title: 'IT Manager' },
    ],
  },
  {
    key: 'marina', name: 'Marina Motors', company: 'Marina Motors Trading LLC', type: 'one_off', owner: 'omar',
    prospect: true, created: '2026-08-25 15:00', startedOn: '2026-09-03', code: 'MarinaMotors',
    services: ['video', 'design'],
    notes: 'Premium car dealership on Sheikh Zayed Road. Q4 showroom launch was cancelled when the regional office froze marketing budgets; account paused until the new year.',
    contacts: [{ name: 'Tariq Mahmoud', email: 'tariq.mahmoud@marinamotors.example', phone: '+971 4 555 3301', title: 'Marketing Manager', primary: true }],
  },
  {
    key: 'summit', name: 'Summit Sports Academy', company: 'Summit Sports Academy LLC', type: 'retainer', owner: 'omar',
    prospect: true, created: '2026-09-10 11:30', startedOn: '2026-09-17', code: 'Summit',
    services: ['video', 'design', 'social'],
    notes: 'Youth football, swimming and tennis academy (Al Quoz, Dubai Sports City). New client this month: coach profile series first, season launch campaign next.',
    contacts: [
      { name: 'Coach Daniel Okafor', email: 'daniel.okafor@summitsports.example', phone: '+971 52 555 1180', title: 'Academy Director', primary: true },
      { name: 'Hiba Al Amiri', email: 'hiba@summitsports.example', phone: '+971 4 555 9912', title: 'Partnerships & Marketing' },
    ],
  },
  {
    key: 'nimbus', name: 'Nimbus Fintech', company: 'Nimbus Payments Ltd (DIFC)', type: 'one_off', owner: 'omar',
    prospect: true, created: '2026-09-08 16:15', code: 'Nimbus', services: ['video', 'design'],
    notes: 'DIFC payments start-up preparing its public launch. Proposal sent for a launch film and motion toolkit.',
    contacts: [{ name: 'Sofia Lindqvist', email: 'sofia@nimbuspay.example', phone: '+971 58 555 4420', title: 'Head of Brand', primary: true }],
  },
  {
    key: 'palmgrove', name: 'Palm Grove Residences', company: 'Palm Grove Properties', type: 'one_off', owner: 'lina',
    prospect: true, created: '2026-09-02 12:45', code: 'PalmGrove', services: ['video', 'design'],
    notes: 'Boutique developer; sales centre opening in November.',
    contacts: [{ name: 'Ravi Menon', email: 'ravi.menon@palmgrove.example', phone: '+971 50 555 6621', title: 'Sales Director', primary: true }],
  },
  {
    key: 'crescent', name: 'Crescent Pharmacy Group', company: 'Crescent Pharmacy Group LLC', type: 'retainer', owner: 'lina',
    prospect: true, created: '2026-08-12 10:00', code: 'Crescent', services: ['social', 'design'],
    notes: '22 pharmacies across the Northern Emirates. Negotiating a three-month social media pilot.',
    contacts: [{ name: 'Huda Al Marri', email: 'huda.almarri@crescentpharmacy.example', phone: '+971 6 555 2044', title: 'Marketing Lead', primary: true }],
  },
  {
    key: 'qasr', name: 'Qasr Al Bahr Heritage Museum', company: 'Qasr Al Bahr Heritage Foundation', type: 'one_off', owner: 'omar',
    prospect: true, created: '2026-09-21 14:20', code: 'QasrAlBahr', services: ['video'],
    notes: 'Pearling-history museum in Al Shindagha. Enquiry about teaser videos for a winter exhibition.',
    contacts: [{ name: 'Maitha Al Falasi', email: 'maitha@qasralbahr.example', phone: '+971 4 555 8830', title: 'Exhibitions Curator', primary: true }],
  },
  {
    key: 'padel', name: 'Emirates Padel Club', company: 'Emirates Padel Club', type: 'one_off', owner: 'omar',
    prospect: true, created: '2026-05-18 09:50', code: 'Padel', services: ['video'],
    notes: 'Enquired about tournament coverage in June; went with an in-house team.',
    contacts: [{ name: 'Marco Ruiz', email: 'marco@emiratespadel.example', phone: '+971 54 555 7002', title: 'Club Manager', primary: true }],
  },
  {
    key: 'aktivacity', name: 'Aktivacity (internal)', company: 'Aktivacity FZ-LLC', type: 'one_off', owner: 'ceo',
    prospect: false, created: '2026-09-08 10:20', code: 'Aktivacity', services: ['video', 'design'],
    notes: 'The agency’s own work: showreel, case studies, pitch material. Not billable.',
    contacts: [],
  },
];
const clientSeed = (k: ClientKey) => CLIENTS.find((c) => c.key === k)!;

/* =========================================================== copywriting == */

const QA = {
  video: {
    approve: ['Approved — pacing and subtitles are spot on.', 'Good cut. Approved.', 'Approved. Nice use of the drone opener.', 'Clean export, correct end card. Approved.', 'Approved — passing to PM.', 'Approved. Grade matches the reference.'],
    changes: ['Subtitles drift about three frames from 0:07. Please resync and re-export.', 'End card is still the old white logo — swap to the gold lockup from guidelines v3.', 'Interiors are graded too cool. Warm them up to match the reference.', 'Music peaks over the VO at 0:12 — duck it by 4–5 dB.', 'The hook is slow. Open on the pool shot and trim the first 1.5 s.'],
    reject: ['Wrong aspect ratio — this was exported 4:5; it needs to be 9:16.', 'This track is not licensed for paid social. Replace it with an approved Artlist track.'],
    pmApprove: ['PM approved — ready for Sales.', 'Checked against the PO. Approved.', 'Approved. Good to go to the client.'],
    pmChanges: ['Client wants the RERA permit number on every property video — add it bottom-left on the end card.', 'Price on the end card should read “from AED 1.2M” per the latest price list.'],
  },
  design: {
    approve: ['Approved.', 'Looks great — approved.', 'Approved. Typography is on-brand.', 'Good. Approved for delivery.', 'Approved — nice crop.'],
    changes: ['Headline sits inside the Stories safe zone — move it down 60 px.', 'Please use the brand gold (#C4964F), not the yellow.', 'Arabic copy needs the updated translation from the client’s email.', 'Logo is too small — minimum 120 px wide.'],
    reject: ['Wrong size — this should be 1080×1350, not square.'],
    pmApprove: ['PM approved.', 'Approved — matches the approved wireframes.'],
    pmChanges: ['Client wants the orange CTA on every layout — please update before sign-off.'],
  },
  seo: {
    approve: ['Approved. Clear recommendations.', 'Good report — approved.', 'Approved; send with the summary email.'],
    changes: ['Add the month-on-month table for the top 20 keywords.', 'Three meta descriptions are over 160 characters — trim them.', 'The article needs at least three internal links to project pages.'],
    reject: ['This is last month’s crawl — please rerun it against the live site.'],
    pmApprove: ['PM approved.'],
    pmChanges: ['Please add the redirect for the old /tracking URL before this goes to the client.'],
  },
  social: {
    approve: ['Approved — the calendar is nicely balanced.', 'Approved.', 'Good mix of formats. Approved.'],
    changes: ['Move the launch post to Thursday — the client wants it live before the weekend.', 'Add the campaign hashtags to every caption.'],
    reject: ['This calendar is missing the second half of the month.'],
    pmApprove: ['PM approved.'],
    pmChanges: ['Client asked for Arabic captions alongside English on every post.'],
  },
  development: {
    approve: ['Approved — passes the QA checklist on staging.', 'Code review done, Lighthouse 94 on mobile. Approved.', 'Approved.'],
    changes: ['Mobile menu overlaps the hero below 380 px — please fix before PM review.', 'Quote form is missing server-side validation on the phone field.', 'The tracking widget calls the API on every keystroke — debounce it (300 ms).'],
    reject: ['This build is pointing at the production API. Switch it to staging and redeploy.'],
    pmApprove: ['Reviewed on staging against the client checklist. Approved.'],
    pmChanges: ['Client wants the “Get a quote” button in orange on every page — please update before sign-off.'],
  },
} satisfies Record<DeptKey, Record<string, string[]>>;

const DELIVERY_NOTES: Record<ClientKey, string[]> = {
  alnoor: ['Shared on client’s Google Drive (Al Noor › Social › this month)', 'Sent via WeTransfer link', 'Shared on client’s Google Drive'],
  desertbloom: ['Sent via WeTransfer link', 'Uploaded to Desert Bloom’s Dropbox', 'Sent to Rania on WhatsApp + WeTransfer'],
  oasis: ['Emailed to Joanna with the caption sheet', 'Shared on client’s Google Drive', 'Sent via WeTransfer link'],
  gulf: ['Sent via WeTransfer link', 'Shared on client’s Google Drive', 'Uploaded to the Gulf Horizon brand portal'],
  falcon: ['Shared Figma link + PNG exports with Vikram', 'Deployed to staging; link sent to Vikram', 'Shared on client’s Google Drive'],
  marina: ['Sent via WeTransfer link'],
  summit: ['Sent via WeTransfer link'],
  aktivacity: ['Published to the agency drive'],
  nimbus: [], palmgrove: [], crescent: [], qasr: [], padel: [],
};
const KICKOFFS: Record<DeptKey, string[]> = {
  video: [
    'Routed. Same editors as last month; the PO is on the project. Shout if the shoot selects are not on the NAS by tomorrow.',
    'Kick-off: reminder that every property video needs the RERA number and the gold lockup on the end card.',
    'Routed to Video. Client wants previews by Thursday so posts can be scheduled for the weekend.',
  ],
  design: [
    'Routed. Copy deck comes from the client’s team — please don’t translate in-house.',
    'Kick-off: same template set as last month; price cards from the latest list only.',
  ],
  seo: [
    'Routed. Priority pages are in the brief; keep the article topic aligned with this month’s video theme.',
    'Kick-off: report due in the first week, please — the client reviews it at their monthly meeting.',
  ],
  social: [
    'Routed. Calendar needs client approval by the 3rd working day.',
    'Kick-off: posting windows unchanged; escalate any sales leads from DMs the same day.',
  ],
  development: ['Routed. Staging first, PM QA before anything reaches the client.'],
};

const CLIENT_OK = ['Client confirmed — scheduled for posting.', 'Approved by the client by email.', 'Client happy; posted on schedule.', 'Approved on the weekly call.'];

const UPLOAD_NOTES: Record<DeptKey, string[]> = {
  video: ['Resynced subtitles and swapped the end card.', 'Warmer grade on interiors, re-exported.', 'Trimmed the hook and ducked the music.', 'Re-exported at 9:16 with the licensed track.'],
  design: ['Moved the headline out of the safe zone.', 'Switched to brand gold and bumped the logo size.', 'Updated Arabic copy from the client email.', 'Resized to 1080×1350.'],
  seo: ['Added the month-on-month table.', 'Trimmed meta descriptions; added internal links.', 'Re-crawled the live site.'],
  social: ['Moved the launch post; hashtags added.', 'Completed the second half of the month.'],
  development: ['Fixed the mobile menu overlap; retested on iPhone SE.', 'Added server-side validation; tests updated.', 'Debounced the tracking lookup.'],
};

const TIME_NOTES: Record<DeptKey, string[]> = {
  video: ['Editing selects', 'Colour grade + subtitles', 'Motion graphics for price cards', 'Exports and uploads', 'Rough cut', 'Fixes from QA'],
  design: ['Layouts', 'Artwork and exports', 'Revisions from QA', 'Stories adaptations', 'Arabic typesetting'],
  seo: ['Keyword tracking', 'On-page changes', 'Writing', 'Technical audit', 'Reporting'],
  social: ['Calendar planning', 'Community management', 'Caption writing', 'Reporting', 'Scheduling posts'],
  development: ['Front-end build', 'CMS setup', 'API integration', 'Code review fixes', 'Testing on staging'],
};

/* ============================================================ deliverables == */

type FileKind =
  | 'reel' | 'film' | 'post' | 'story' | 'thumb' | 'keyvisual' | 'web' | 'mobile'
  | 'seo-report' | 'onpage' | 'blog' | 'keywords' | 'metadata' | 'redirects' | 'gbp' | 'citations' | 'location'
  | 'calendar' | 'community' | 'captions' | 'release' | 'offer-copy';

const BLOG_TITLES: Record<string, string[]> = {
  alnoor: [
    'Off-plan vs ready property in Dubai: what first-time buyers should know',
    'Dubai Marina or Dubai Hills? Choosing the right community for your family',
    'How post-handover payment plans work',
    'Golden Visa through property: the 2026 checklist',
    'What service charges really cover in a Dubai tower',
    'Five questions to ask before you sign an SPA',
  ],
  oasis: ['Invisalign or braces: which suits you?', 'What to expect at your first hygiene appointment', 'Teeth whitening myths, answered by our dentists'],
  falcon: ['Sea vs air freight from Jebel Ali: cost and time compared'],
};

interface FileCtx { client: ClientKey; clientName: string; period: PeriodInfo; slotName: string; seq: number; version: number; dept: DeptKey }

function fileFor(kind: FileKind, c: FileCtx): Blob {
  const code = clientSeed(c.client).code;
  const nn = String(c.seq).padStart(2, '0');
  const base = (label: string) => `${code}_${c.period.short}_${label}_${nn}_v${c.version}`;
  const media = {
    reel: c.client === 'desertbloom' ? 'reel-cafe-vertical.mp4' : c.client === 'alnoor' ? 'reel-realestate-vertical.mp4' : 'promo-generic-landscape.mp4',
    film: c.client === 'gulf' ? 'film-hotel-landscape.mp4' : 'promo-generic-landscape.mp4',
    post: c.client === 'desertbloom' ? 'post-cafe-square.jpg' : c.client === 'oasis' ? 'post-dental-square.jpg'
      : c.client === 'gulf' ? 'keyvisual-hotel.jpg' : c.client === 'falcon' ? 'website-desktop.png' : 'post-realestate-square.jpg',
  };
  const accent: Record<string, [number, number, number]> = {
    alnoor: [14, 52, 74], oasis: [24, 118, 134], desertbloom: [122, 78, 52], falcon: [18, 44, 90], gulf: [150, 70, 60],
  };
  const doc = (label: string, d: PdfDoc) => pdf(base(label), { accent: accent[c.client], ...d });
  const meta: [string, string][] = [['Client', c.clientName], ['Period', c.period.label], ['Deliverable', `${c.slotName} (v${c.version})`], ['Prepared by', 'Aktivacity']];
  const pct = () => `${int(4, 19)}.${int(0, 9)}%`;

  switch (kind) {
    case 'reel': return asset(media.reel, base('Reel'));
    case 'film': return asset(media.film, base('Film'));
    case 'post': return asset(media.post, base('Post'));
    case 'story': return asset(c.client === 'alnoor' ? 'story-realestate-vertical.jpg' : media.post, base('Story'));
    case 'thumb': return asset('thumbnail-landscape.jpg', base('Thumbnail'));
    case 'keyvisual': return asset('keyvisual-hotel.jpg', base('KeyVisual'));
    case 'web': return asset('website-desktop.png', base('Desktop'));
    case 'mobile': return asset('website-mobile.png', base('Mobile'));
    case 'seo-report': return doc('SEO_Report', {
      title: `SEO Performance Report - ${c.period.label}`, subtitle: c.clientName, meta,
      blocks: [
        { h: 'Summary' },
        { p: `Organic sessions grew ${pct()} month on month, led by the community and project pages. ${int(18, 41)} tracked keywords now rank on page one, up from ${int(12, 30)}. Core Web Vitals pass on mobile for all templates.` },
        { h: 'Keyword movements' },
        { row: ['Keyword', 'Position', 'Change', 'Volume'] },
        ...['apartments for sale dubai marina', 'off plan projects dubai', 'dubai hills villas', 'jvc townhouses', 'payment plan apartments dubai']
          .map((k) => ({ row: [k, String(int(2, 14)), `+${int(1, 6)}`, `${int(8, 60)}00`] })),
        { h: 'Work completed' },
        { li: 'Rewrote title tags and meta descriptions for 12 project pages.' },
        { li: 'Fixed 23 broken internal links and two redirect chains.' },
        { li: 'Added FAQ schema to the payment-plan pages.' },
        { h: 'Next month' },
        { li: 'Publish two long-form guides targeting investor queries.' },
        { li: 'Build local citations for the new sales centre.' },
      ],
    });
    case 'onpage': return doc('OnPage_Log', {
      title: 'On-page Optimisation Log', subtitle: `${c.clientName} - ${c.period.label}`, meta,
      blocks: [
        { h: 'Pages optimised' },
        ...['/projects/marina-heights', '/communities/dubai-hills', '/payment-plans', '/projects/jvc-townhouses', '/about', '/contact']
          .map((u) => ({ li: `${u} - title, meta description, H1 and image alt text updated; internal links added.` })),
        { h: 'Technical' },
        { p: 'Canonical tags corrected on paginated listings. Image weight reduced by 38% with WebP conversion. XML sitemap resubmitted in Search Console.' },
      ],
    });
    case 'blog': {
      const titles = BLOG_TITLES[c.client] ?? BLOG_TITLES.alnoor;
      const title = titles[(c.seq + c.period.month) % titles.length];
      return doc('Blog_Article', {
        title: 'Blog Article', subtitle: title, meta: [...meta, ['Length', `${int(1100, 1600)} words`]],
        blocks: [
          { h: title },
          { p: 'Buying in Dubai is easier than ever, but the choices can be overwhelming. This guide walks through what matters most, in plain language, with the questions our clients ask every week.' },
          { h: 'What to consider first' },
          { p: 'Start with how you will use the home. Families weigh school runs and parks; investors look at rental yield, service charges and handover dates. Both should read the payment plan closely.' },
          { h: 'Understanding the numbers' },
          { p: 'Compare the total cost, not only the price per square foot: registration fees, service charges and any post-handover instalments. Ask for the escrow account details and the RERA project number.' },
          { h: 'Next steps' },
          { p: 'Book a viewing, bring your questions, and ask for the floor plan and the payment schedule in writing. Our consultants are available seven days a week.' },
        ],
      });
    }
    case 'keywords': return doc('Keyword_Research', {
      title: 'Keyword Research', subtitle: c.clientName, meta,
      blocks: [
        { h: 'Priority clusters' },
        { row: ['Keyword', 'Volume', 'Difficulty', 'Intent'] },
        ...['freight forwarding dubai', 'sea freight jebel ali', 'air cargo dubai', 'warehousing jafza', 'shipment tracking uae', 'logistics company dubai']
          .map((k) => ({ row: [k, `${int(2, 30)}00`, String(int(18, 64)), pick(['Commercial', 'Transactional', 'Informational'])] })),
        { h: 'Recommendations' },
        { li: 'One service page per freight mode, each targeting its cluster.' },
        { li: 'An industries hub for automotive, retail and healthcare logistics.' },
      ],
    });
    case 'metadata': return doc('Metadata_Schema', {
      title: 'Metadata & Schema Sheet', subtitle: c.clientName, meta,
      blocks: [
        { h: 'Page metadata' },
        ...['Home', 'Sea freight', 'Air freight', 'Warehousing', 'Track shipment', 'Contact'].map((p) => ({ li: `${p}: title (55-60 chars) and meta description (150-155 chars) written; Organization and Service schema mapped.` })),
        { h: 'Structured data' },
        { p: 'Organization, LocalBusiness and BreadcrumbList JSON-LD templates provided for the CMS.' },
      ],
    });
    case 'redirects': return doc('Redirect_Map', {
      title: '301 Redirect Map', subtitle: c.clientName, meta,
      blocks: [{ row: ['Old URL', 'New URL', '', ''] }, ...['/services.php', '/tracking.aspx', '/about-us.html', '/contact-us.html'].map((u) => ({ row: [u, u.replace(/\.(php|aspx|html)$/, '').replace('-us', ''), '', ''] }))],
    });
    case 'gbp': return doc('GBP_Report', {
      title: 'Google Business Profile Optimisation', subtitle: `${c.clientName} - ${c.period.label}`, meta,
      blocks: [
        { h: 'Profiles' },
        ...['Jumeirah', 'Al Barsha', 'Mirdif'].map((b) => ({ li: `${b}: categories reviewed, ${int(6, 14)} new photos, ${int(3, 9)} Q&A answered, ${int(8, 25)} reviews replied to.` })),
        { h: 'Results' },
        { p: `Calls from Maps up ${pct()}; direction requests up ${pct()}. Average rating ${int(46, 49) / 10} across ${int(420, 690)} reviews.` },
      ],
    });
    case 'citations': return doc('Citation_Audit', {
      title: 'Local Citation Audit', subtitle: c.clientName, meta,
      blocks: [{ p: `${int(28, 44)} directories checked; ${int(4, 11)} inconsistencies in phone numbers and opening hours corrected.` }],
    });
    case 'location': return doc('Location_Page', {
      title: 'Location Page Copy', subtitle: `${c.clientName} - ${pick(['Jumeirah', 'Al Barsha', 'Mirdif'])} clinic`, meta,
      blocks: [
        { h: 'Hero' }, { p: 'Gentle, modern dentistry in the heart of the community. Same-week appointments, evening hours and a team that explains every step.' },
        { h: 'Services' }, { li: 'General and preventive dentistry' }, { li: 'Invisalign and braces' }, { li: 'Whitening and cosmetic care' }, { li: 'Children\'s dentistry' },
        { h: 'Getting here' }, { p: 'Free parking behind the building; five minutes from the metro. Open Saturday to Thursday, 9am to 9pm.' },
      ],
    });
    case 'calendar': return doc('Content_Calendar', {
      title: `Content Calendar - ${c.period.label}`, subtitle: c.clientName, meta,
      blocks: [
        { h: 'Plan' },
        { row: ['Week', 'Platform', 'Format', 'Theme'] },
        ...[1, 2, 3, 4].flatMap((w) => [
          { row: [`Week ${w}`, 'Instagram', pick(['Reel', 'Carousel', 'Static']), pick(['Launch', 'Behind the scenes', 'Offer', 'Community', 'Tips'])] },
          { row: [`Week ${w}`, pick(['TikTok', 'LinkedIn', 'Facebook']), pick(['Reel', 'Static', 'Story']), pick(['Testimonial', 'FAQ', 'Event', 'Product'])] },
        ]),
        { h: 'Notes' },
        { p: 'Posting windows: 12:00-13:00 and 19:00-21:00 GST. Arabic and English captions on every post. Paid boosts on the two best-performing posts each week.' },
      ],
    });
    case 'community': return doc('Community_Report', {
      title: 'Community Management Report', subtitle: `${c.clientName} - ${c.period.label}`, meta,
      blocks: [
        { h: 'Highlights' },
        { li: `Followers +${int(180, 940)} across Instagram and TikTok.` },
        { li: `Engagement rate ${int(3, 7)}.${int(0, 9)}% (industry benchmark 2.1%).` },
        { li: `${int(120, 480)} comments and DMs answered; median response time ${int(18, 55)} minutes.` },
        { h: 'Top posts' }, { li: 'Weekend reel - highest reach of the month.' }, { li: 'Carousel FAQ - most saves.' },
      ],
    });
    case 'captions': return doc('Caption_Pack', {
      title: 'Caption Pack', subtitle: `${c.clientName} - ${c.period.label}`, meta,
      blocks: c.client === 'gulf' ? [
        { h: 'Paid social captions' },
        { li: 'Three nights by the sea, one on us. Book your Autumn Staycation direct and save.' },
        { li: `Sunrise swims, late checkouts, kids eat free. Stay 3, pay 2 until ${dMonth('2026-11-30')}.` },
        { li: 'From the Palm to the Hatta mountains: pick your escape this autumn.' },
        { h: 'Targeting' },
        { p: 'UAE residents 28-55, families and couples; interests travel, fine dining, wellness. Exclude recent bookers (30 days). Budget split 60/40 Instagram/TikTok.' },
      ] : [
        { h: 'Captions (English; Arabic sheet attached separately)' },
        { li: 'Autumn is here, and so is the Pistachio Rose Latte. Which one are you ordering first?' },
        { li: 'Slow mornings, good coffee. Tag who you are bringing this weekend.' },
        { li: 'Our baristas taste every batch before it reaches your cup. That is the Desert Bloom promise.' },
      ],
    });
    case 'offer-copy': return doc('Offer_Page_Copy', {
      title: 'Offer Landing Page Copy', subtitle: `${c.clientName} - Autumn Staycation`, meta,
      blocks: [
        { h: 'Title tag and meta' },
        { p: 'Autumn Staycation Offer: Stay 3 Nights, Pay 2 | Gulf Horizon Hotels (58 chars). Book direct for our best autumn rate across JBR, the Palm, Hatta and Ras Al Khaimah. Kids eat free. (151 chars)' },
        { h: 'H1' }, { p: 'Your autumn escape: stay three nights, pay for two' },
        { h: 'Body' },
        { p: `Swap the city for sea views, mountain air or desert sunsets - all within 90 minutes of Dubai. Book any three consecutive nights between ${dMonth('2026-10-01')} and ${dMonth('2026-11-30')} and the third night is on us, with breakfast, late checkout and free meals for children under 12.` },
        { h: 'FAQ schema' }, { li: 'Can I combine the offer with loyalty points? Yes.' }, { li: 'Is the offer available for UAE residents only? No, it is open to all guests.' },
      ],
    });
    case 'release': return doc('Release_Notes', {
      title: `Release Notes - ${c.slotName}`, subtitle: c.clientName, meta,
      blocks: [
        { h: 'Deployed to staging' },
        { li: 'Responsive templates for home, services and contact.' },
        { li: 'CMS content types with preview and scheduled publishing.' },
        { li: 'Forms post to the CRM webhook with server-side validation.' },
        { h: 'Checks' }, { p: `Lighthouse mobile performance ${int(88, 97)}, accessibility ${int(92, 100)}. Tested on Chrome, Safari, Edge; iOS 17 and Android 14.` },
      ],
    });
    default: return asset('reference-moodboard.jpg', base('File'));
  }
}

function poPdf(p: { client: ClientKey; code: string; title: string; po: string; price: number; period: PeriodInfo; lines: string[] }): Blob {
  const c = clientSeed(p.client);
  return pdf(`PO_${p.po.replace(/[^A-Za-z0-9]+/g, '-')}`, {
    title: 'Purchase Order', subtitle: `${c.company} - ${p.po}`, accent: [40, 40, 48],
    meta: [['PO number', p.po], ['Issued to', 'Aktivacity FZ-LLC'], ['Project', p.title], ['Period', p.period.label], ['Contact', c.contacts[0].name]],
    blocks: [
      { h: 'Items' },
      ...p.lines.map((l) => ({ li: l })),
      { gap: 6 },
      { row: ['Subtotal', `AED ${p.price.toLocaleString('en-US')}.00`, '', ''] },
      { row: ['VAT 5%', `AED ${(p.price * 0.05).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, '', ''] },
      { row: ['Total', `AED ${(p.price * 1.05).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, '', ''] },
      { h: 'Terms' },
      { p: 'Payment 30 days from invoice. Please quote this PO number on the invoice. Deliverables to be approved by the named contact before publication.' },
    ],
    footer: `${c.company} | Purchase order ${p.po}`,
  });
}

function briefPdf(title: string, client: ClientKey, sections: [string, string][]): Blob {
  const c = clientSeed(client);
  return pdf(`Brief_${c.code}_${title.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}`, {
    title: 'Creative Brief', subtitle: `${c.name} - ${title}`,
    meta: [['Client', c.name], ['Account', c.owner === 'omar' ? 'Omar Haddad' : c.owner === 'lina' ? 'Lina Farouk' : 'Khalid Al Mansoori']],
    blocks: sections.flatMap(([h, p]) => [{ h }, { p }]),
  });
}

/* ================================================================= flows == */

type Stop = 'none' | 'uploaded' | 'lead' | 'pm' | 'approved' | 'delivered' | 'completed';

interface SlotPlan {
  /** First upload, or null for a slot nobody has touched yet. */
  upload: Date | null;
  lead?: QaDecision[];
  pm?: QaDecision[];
  /** Where the story leaves this slot. 'completed' is the default. */
  stop?: Stop;
  deliverAt?: Date;
  completeAt?: Date;
  /** Who completes: Sales on the client's word, or the client in the portal. */
  completeBy?: 'sales' | 'client';
}

interface AssignmentSpec {
  who: string;
  count: number;
  base: string;
  title: string;
  instructions: string;
  kind: FileKind | ((seq: number) => FileKind);
  start: string;
  end: string;
  priority?: Priority;
  unitHours: number;
  description?: string;
  reference?: Blob;
  /** Explicit per-slot story; missing entries follow the default plan. */
  plans?: (SlotPlan | undefined)[];
  /** When this assignment is made; defaults to the team's planning time. */
  planAt?: Date;
}

interface TeamSpec {
  dept: DeptKey;
  planned: number;
  /** null routes the team without a lead (awaiting assignment). */
  lead?: string | null;
  planAt?: Date;
  assignments: AssignmentSpec[];
}

interface ProjectSpec {
  key: string;
  client: ClientKey;
  y: number;
  m: number;
  title: string;
  projectType: string;
  objective: string;
  description: string;
  requirements: string;
  clientNotes?: string;
  internalNotes?: string;
  po: string;
  /** null for the agency's own, unbillable work. */
  price: number | null;
  requiresPmQa: boolean;
  priority?: Priority;
  deadline: string;
  recurs?: boolean;
  pm: string;
  teams: TeamSpec[];
  /** Triage; null leaves the project unrouted. */
  triageAt: Date | null;
  kickoff?: string;
  comments?: { at: Date; who: string; body: string; slot?: [DeptKey, number] }[];
  /** How historic slots end: in the portal or by Sales. */
  completeBy?: (seq: number) => 'sales' | 'client';
  /** Keep attachments off copies: only the first filing carries the PO PDF. */
  attachPo?: boolean;
  poLines?: string[];
  brief?: [string, string][];
}

function specToIntake(spec: ProjectSpec, extra: Partial<ProjectIntakeInput> = {}): ProjectIntakeInput {
  const clientId = reg.clients.get(spec.client)!;
  return {
    clientId, period: period(spec.y, spec.m).value, title: spec.title,
    departments: spec.teams.map((t) => ({ departmentId: DEPT[t.dept], plannedDeliverables: t.planned })),
    projectType: spec.projectType, objective: spec.objective, description: spec.description,
    poReference: spec.po, requirements: spec.requirements, clientNotes: spec.clientNotes ?? null,
    internalNotes: null, deadline: day(spec.deadline), priority: spec.priority ?? 'normal',
    priceAmount: spec.price === null ? null : spec.price.toFixed(2), requiresPmQa: spec.requiresPmQa, recursMonthly: spec.recurs ?? false,
    opportunityId: null, ...extra,
  };
}

function remember(spec: ProjectSpec, projectId: number, code: string, clientMonthId: number): ProjectRec {
  const rec: ProjectRec = {
    key: spec.key, id: projectId, code, client: spec.client, sales: clientSeed(spec.client).owner,
    pm: spec.pm, requiresPmQa: spec.requiresPmQa, y: spec.y, m: spec.m,
  };
  reg.projects.set(spec.key, rec);
  reg.months.set(monthKey(spec.client, spec.y, spec.m), clientMonthId);
  return rec;
}

/** Sales files a project the ordinary way, with its PO attached. */
async function fileSpec(spec: ProjectSpec, extra: Partial<ProjectIntakeInput> = {}): Promise<ProjectRec> {
  const sales = actor(clientSeed(spec.client).owner);
  const r = await A.fileProject(sales, specToIntake(spec, extra));
  const rec = remember(spec, r.projectId, r.projectCode, r.clientMonthId);
  await attachPaperwork(spec, rec);
  return rec;
}

async function attachPaperwork(spec: ProjectSpec, rec: ProjectRec): Promise<void> {
  const sales = actor(rec.sales);
  if (spec.attachPo !== false && spec.price !== null) {
    // The PO document itself (§3): its own kind, shown beside the PO reference.
    await A.attach(sales, { projectId: rec.id, purpose: 'po', kind: 'po' }, poPdf({
      client: spec.client, code: rec.code, title: spec.title, po: spec.po, price: spec.price, period: period(spec.y, spec.m),
      lines: spec.poLines ?? spec.teams.map((t) => `${t.planned} x ${t.dept === 'seo' ? 'SEO' : t.dept[0].toUpperCase() + t.dept.slice(1)} deliverables - ${spec.title}`),
    }));
  }
  if (spec.brief) await A.attach(sales, { projectId: rec.id, purpose: 'brief' }, briefPdf(spec.title, spec.client, spec.brief));
}

/** Schedules everything after filing: triage, planning, the slots, the comments. */
function scheduleProject(spec: ProjectSpec): void {
  if (spec.triageAt === null) return;
  sim.spawn(spec.triageAt, `triage ${spec.key}`, async () => {
    const p = project(spec.key);
    const pm = actor(spec.pm);
    await A.triage(pm, {
      projectId: p.id, priority: spec.priority ?? 'normal', deadline: day(spec.deadline),
      internalNotes: spec.internalNotes ?? null, requiresPmQa: spec.requiresPmQa,
      teams: spec.teams.map((t) => ({
        departmentId: DEPT[t.dept], plannedDeliverables: t.planned,
        teamLeadId: t.lead === null ? null : ID[t.lead ?? LEAD[t.dept]],
      })),
    });
    const kickoff = spec.kickoff ?? (chance(0.45) ? pick(KICKOFFS[spec.teams[0].dept]) : null);
    if (kickoff) await A.comment(pm, { projectId: p.id }, kickoff);
    spec.teams.forEach((team, i) => {
      if (team.lead === null) return;
      const at = team.planAt ?? later(sim.date(), 1.5 + i * 0.75 + rand());
      const now = team.assignments.filter((a) => !a.planAt);
      if (now.length) sim.spawn(at, `plan ${spec.key} ${team.dept}`, () => planAssignments(spec, team, now));
      for (const a of team.assignments.filter((x) => x.planAt)) {
        sim.spawn(a.planAt!, `plan ${spec.key} ${team.dept} ${a.who}`, () => planAssignments(spec, team, [a]));
      }
    });
  });
  for (const c of spec.comments ?? []) {
    sim.spawn(c.at, `comment ${spec.key}`, async () => {
      const p = project(spec.key);
      const target = c.slot ? { deliverableId: slot(spec.key, c.slot[0], c.slot[1]).id } : { projectId: p.id };
      await A.comment(actor(c.who), target, c.body);
    });
  }
}

async function planAssignments(spec: ProjectSpec, team: TeamSpec, list: AssignmentSpec[]): Promise<void> {
  const p = project(spec.key);
  const lead = actor(team.lead ?? LEAD[team.dept]);
  const [pd] = await sql<{ id: string }[]>`
    SELECT id FROM project_departments WHERE project_id = ${p.id} AND department_id = ${DEPT[team.dept]}`;
  for (const a of list) {
    const r = await A.assign(lead, {
      projectDepartmentId: Number(pd.id), assigneeId: ID[a.who], title: a.title, instructions: a.instructions,
      startDate: day(a.start), endDate: day(a.end), priority: a.priority ?? spec.priority ?? 'normal',
      deliverableCount: a.count, deliverableBaseName: a.base, deliverableDescription: a.description ?? null,
      dueDate: null, estimatedMinutes: Math.round(a.count * a.unitHours * 60),
    });
    reg.work.push({
      assignmentId: r.assignmentId, projectId: p.id, user: a.who, dept: team.dept,
      start: day(a.start), end: day(a.end), closedOn: null, weight: a.count * a.unitHours,
    });
    if (a.reference) {
      await A.attach(lead, { projectId: p.id, assignmentId: r.assignmentId, purpose: 'reference' }, a.reference);
    }
    const rows = await sql<{ id: string; name: string; sequence_no: number }[]>`
      SELECT id, name, sequence_no FROM deliverables WHERE assignment_id = ${r.assignmentId} ORDER BY sequence_no`;
    rows.forEach((row, i) => {
      const s: SlotRec = { id: Number(row.id), name: row.name, seq: Number(row.sequence_no), dept: team.dept, assignee: a.who, project: spec.key };
      reg.slots.set(`${spec.key}:${team.dept}:${s.seq}`, s);
      const plan = a.plans?.[i] ?? defaultPlan(a, i, rows.length);
      if (plan.upload) {
        const kind = typeof a.kind === 'function' ? a.kind(s.seq) : a.kind;
        sim.spawn(plan.upload, `slot ${spec.key} ${s.name}`, () => slotFlow(spec, team.dept, s, kind, plan));
      }
    });
  }
}

/** The ordinary life of a slot in a past month: uploads spread over the window, a few sent back. */
function defaultPlan(a: AssignmentSpec, i: number, n: number): SlotPlan {
  const from = nextWorkdayDate(day(a.start), 1);
  let to = day(a.end);
  for (let k = 0; k < 2; k++) to = prevWorkdayDate(to);
  const span = Math.max(0, workdaysBetween(from, to));
  const offset = n <= 1 ? Math.floor(span / 2) : Math.round((i * span) / (n - 1));
  const date = offset === 0 ? from : nextWorkdayDate(from, offset);
  const lead: QaDecision[] = [];
  const r = rand();
  if (r < 0.05) lead.push('rejected');
  else if (r < 0.24) lead.push('changes_requested');
  if (lead.length && chance(0.15)) lead.push('changes_requested');
  const pm: QaDecision[] = chance(0.06) ? ['changes_requested'] : [];
  return { upload: atLocal(date, hm(int(10 * 60, 16 * 60 + 30))), lead, pm };
}
function prevWorkdayDate(iso: string): string {
  let d = addDays(iso, -1);
  while (weekend(d)) d = addDays(d, -1);
  return d;
}
function workdaysBetween(a: string, b: string): number {
  let n = 0;
  for (let d = a; d < b; d = addDays(d, 1)) if (!weekend(addDays(d, 1))) n++;
  return n;
}

/** One deliverable, from first upload to wherever its story ends. */
async function slotFlow(spec: ProjectSpec, dept: DeptKey, s: SlotRec, kind: FileKind, plan: SlotPlan): Promise<void> {
  const p = project(spec.key);
  const exec = actor(s.assignee);
  const lead = actor(LEAD[dept]);
  const pm = actor(p.pm);
  const sales = actor(p.sales);
  const stop = plan.stop ?? 'completed';
  const ctx = (version: number): FileCtx => ({
    client: spec.client, clientName: clientSeed(spec.client).name, period: period(spec.y, spec.m),
    slotName: s.name, seq: s.seq, version, dept,
  });

  let version = 0;
  let leadRound = 0;
  let pmRound = 0;
  let note: string | null = null;
  for (;;) {
    version++;
    await A.upload(exec, s.id, fileFor(kind, ctx(version)), note);
    if (stop === 'uploaded' && leadRound >= (plan.lead?.length ?? 0) && pmRound >= (plan.pm?.length ?? 0)) return;
    await sim.at(later(sim.date(), 1.5 + rand() * 3), `lead QA ${s.name}`);
    const decision = plan.lead?.[leadRound] ?? 'approved';
    leadRound++;
    await A.review(lead, s.id, decision, qaComment(dept, decision, 'lead'));
    if (decision !== 'approved') {
      if (stop === 'lead' && leadRound >= (plan.lead?.length ?? 0)) return;
      note = pick(UPLOAD_NOTES[dept]);
      if (chance(0.35)) await A.comment(exec, { deliverableId: s.id }, `On it — ${note.charAt(0).toLowerCase()}${note.slice(1)}`);
      await sim.at(dubaiMinutes(sim.now) < 12 * 60 && chance(0.4) ? later(sim.date(), 3 + rand() * 2) : nextWorkday(sim.date(), 10 * 60, 15 * 60), `reupload ${s.name}`);
      continue;
    }
    if (p.requiresPmQa) {
      if (stop === 'pm') return;
      await sim.at(nextWorkday(sim.date(), 9 * 60 + 20, 11 * 60 + 40), `PM QA ${s.name}`);
      const pd = plan.pm?.[pmRound] ?? 'approved';
      pmRound++;
      await A.review(pm, s.id, pd, qaComment(dept, pd, 'pm'));
      if (pd !== 'approved') {
        note = pick(UPLOAD_NOTES[dept]);
        await sim.at(later(sim.date(), 2 + rand() * 3), `reupload ${s.name}`);
        continue;
      }
    }
    break;
  }
  if (stop === 'approved') return;

  await sim.at(plan.deliverAt ?? nextWorkday(sim.date(), 11 * 60 + 10, 12 * 60 + 40), `deliver ${s.name}`);
  const deliveryId = deliveryOf(s.id);
  await A.delivery(sales, deliveryId, 'delivered', { notes: pick(DELIVERY_NOTES[spec.client]) });
  if (stop === 'delivered') return;

  const by = plan.completeBy ?? spec.completeBy?.(s.seq) ?? 'sales';
  if (by === 'client') {
    await sim.at(plan.completeAt ?? nextWorkday(sim.date(), 9 * 60 + 30, 13 * 60), `client approves ${s.name}`);
    await A.clientDecision(portalActor(spec.client), deliveryId, 'approved');
  } else {
    await sim.at(plan.completeAt ?? nextWorkday(sim.date(), 14 * 60 + 30, 17 * 60, int(1, 3)), `complete ${s.name}`);
    await A.delivery(sales, deliveryId, 'completed', { clientFeedback: pick(CLIENT_OK) });
  }
}

function qaComment(dept: DeptKey, decision: QaDecision, stage: 'lead' | 'pm'): string | null {
  const bank = QA[dept];
  if (stage === 'pm') return decision === 'approved' ? (chance(0.6) ? pick(bank.pmApprove) : null) : pick(bank.pmChanges);
  if (decision === 'approved') return chance(0.75) ? pick(bank.approve) : null;
  return decision === 'rejected' ? pick(bank.reject) : pick(bank.changes);
}

const portalLogins = new Map<ClientKey, string>();
function portalActor(client: ClientKey): Actor {
  const key = portalLogins.get(client);
  if (!key) throw new Error(`No portal login for ${client}`);
  return actor(key);
}

/* ======================================================= month machinery == */

/** Sales copies last month's orders into the next month (brief §38). */
function scheduleCopy(at: Date, client: ClientKey, from: [number, number], specs: ProjectSpec[], sourceKeys: string[]): void {
  sim.spawn(at, `copy ${client} → ${specs[0].y}-${specs[0].m}`, async () => {
    const sales = actor(clientSeed(client).owner);
    const fromMonthId = reg.months.get(monthKey(client, from[0], from[1]));
    if (!fromMonthId) throw new Error(`No month ${from.join('-')} for ${client}`);
    const projects: CopyProjectInput[] = specs.map((spec, i) => ({
      sourceProjectId: project(sourceKeys[i]).id, title: spec.title,
      departments: spec.teams.map((t) => ({ departmentId: DEPT[t.dept], plannedDeliverables: t.planned })),
      deadline: day(spec.deadline), priceAmount: spec.price === null ? null : spec.price.toFixed(2), requirements: spec.requirements,
      clientNotes: spec.clientNotes ?? null, internalNotes: null,
    }));
    const r = await A.copyMonth(sales, { clientId: reg.clients.get(client)!, fromMonthId, period: period(specs[0].y, specs[0].m).value, projects });
    r.projects.forEach((created, i) => remember(specs[i], created.projectId, created.projectCode, r.clientMonthId));
    // The client's PO for the new month arrives with the order.
    await sim.at(later(sim.date(), 0.5 + rand()));
    for (const spec of specs) await attachPaperwork({ ...spec, brief: undefined }, project(spec.key));
    for (const spec of specs) scheduleProject(spec);
  });
}

function scheduleClose(at: Date, client: ClientKey, y: number, m: number): void {
  sim.spawn(at, `close ${client} ${y}-${m}`, async () => {
    await A.closeMonth(actor(clientSeed(client).owner), reg.months.get(monthKey(client, y, m))!);
  });
}

/** Draft and issue the month's invoice; optionally record payment. */
function scheduleInvoice(client: ClientKey, y: number, m: number, issueAt: Date, paidAt: Date | null): void {
  sim.spawn(issueAt, `invoice ${client} ${y}-${m}`, async () => {
    const sales = actor(clientSeed(client).owner);
    const id = await A.draftInvoice(sales, reg.months.get(monthKey(client, y, m))!);
    await A.issue(sales, id);
    reg.invoices.set(monthKey(client, y, m), id);
    if (paidAt) {
      sim.spawn(paidAt, `paid ${client} ${y}-${m}`, async () => {
        await A.paid(sales, reg.invoices.get(monthKey(client, y, m))!, dubaiDate(sim.now));
      });
    }
  });
}

/* ============================================================== Al Noor == */

const AL_NOOR_MONTHS = [
  { m: 1, theme: 'the Marina Heights launch', videos: 4, designs: 8, editors: ['ahmed', 'yusuf'], designers: ['sara', 'james'] },
  { m: 2, theme: 'Dubai Hills villas', videos: 4, designs: 8, editors: ['ahmed', 'yusuf'], designers: ['sara', 'james'] },
  { m: 3, theme: 'the Ramadan and Eid al-Fitr campaign', videos: 6, designs: 10, editors: ['ahmed', 'yusuf'], designers: ['sara', 'james'] },
  { m: 4, theme: 'the spring investor open house', videos: 6, designs: 10, editors: ['ahmed', 'yusuf'], designers: ['sara', 'zainab'] },
  { m: 5, theme: 'JVC townhouses and Eid al-Adha', videos: 6, designs: 12, editors: ['ahmed', 'bilal'], designers: ['sara', 'zainab'] },
  { m: 6, theme: 'the summer payment plan', videos: 6, designs: 12, editors: ['ahmed', 'bilal'], designers: ['sara', 'zainab'] },
  { m: 7, theme: 'the investor webinar series', videos: 8, designs: 14, editors: ['ahmed', 'yusuf'], designers: ['sara', 'zainab'] },
  { m: 8, theme: 'back-to-school family homes', videos: 8, designs: 16, editors: ['ahmed', 'yusuf'], designers: ['sara', 'zainab'] },
] as const;

const VIDEO_PRICE: Record<number, number> = { 4: 18000, 6: 24000, 8: 29500, 10: 34000 };
const alNoorPo = (y: number, m: number, n: number) => `ANRE/PO/${y}/${String(m * 4 + n).padStart(3, '0')}`;

function alNoorVideos(y: number, m: number, count: number, editors: readonly string[], theme: string): ProjectSpec {
  const p = period(y, m);
  const half = Math.ceil(count / 2);
  const wds = baseWorkdays(y, m);
  return {
    key: `alnoor-${y}-${m}-videos`, client: 'alnoor', y, m,
    title: `Social Media Videos — ${p.label}`, projectType: 'Social media videos',
    objective: `${count} short-form vertical videos for Instagram Reels, TikTok and YouTube Shorts supporting ${theme}.`,
    description: `Monthly retainer deliverable. Footage from this month's shoot plus the drone library; motion-graphics price cards; Arabic and English subtitles.`,
    requirements: '9:16 vertical, 1080×1920, 20–35 s each. Arabic + English subtitles burned in. RERA permit number and the gold Al Noor lockup on the end card. Licensed music only (Artlist).',
    clientNotes: 'Mariam approves every cut. Send previews by Thursday so posts can be scheduled for the weekend.',
    internalNotes: `Rushes on the NAS under /AlNoor/${y}-${String(m).padStart(2, '0')}. Reuse the approved end-card template.`,
    po: alNoorPo(y, m, 1), price: VIDEO_PRICE[count], requiresPmQa: true, priority: 'high',
    deadline: wdDate(y, m, -2), pm: 'daniel', recurs: true,
    triageAt: wd(y, m, 1, '09:35'),
    kickoff: m === 1 ? 'Kick-off for the Al Noor retainer: PO and brief are attached. Hassan — first four reels for the Marina Heights launch; please flag anything unclear today.' : undefined,
    completeBy: (seq) => (m >= 6 && seq % 3 !== 0 ? 'client' : 'sales'),
    teams: [{
      dept: 'video', planned: count,
      assignments: [
        {
          who: editors[0], count: half, base: 'Video', title: `Edit reels 01–${String(half).padStart(2, '0')}: ${theme}`,
          instructions: 'Cut from the shoot selects on the NAS. Follow the storyboard in the brief; hook in the first two seconds; EN/AR subtitles; export H.264 1080×1920.',
          kind: 'reel', start: wds[1], end: wds[Math.min(14, wds.length - 3)], unitHours: 9,
        },
        {
          who: editors[1], count: count - half, base: 'Video', title: `Edit reels ${String(half + 1).padStart(2, '0')}–${String(count).padStart(2, '0')}: ${theme}`,
          instructions: 'Lifestyle and amenities cuts. Match the grade of the first batch; keep the same end card; EN/AR subtitles.',
          kind: 'reel', start: wds[3], end: wds[Math.min(16, wds.length - 2)], unitHours: 9,
        },
      ],
    }],
  };
}

function alNoorDesigns(y: number, m: number, count: number, designers: readonly string[], theme: string): ProjectSpec {
  const p = period(y, m);
  const half = Math.ceil(count / 2);
  const wds = baseWorkdays(y, m);
  return {
    key: `alnoor-${y}-${m}-designs`, client: 'alnoor', y, m,
    title: `Social Media Designs — ${p.label}`, projectType: 'Social media designs',
    objective: `${count} static posts and stories for ${theme}.`,
    description: 'Feed posts (1080×1350) and matching stories (1080×1920) in English and Arabic, built from the brand template library.',
    requirements: 'Brand guidelines v3: gold #C4964F, Avenir Next, logo min. 120 px. RERA permit number on every property ad. Deliver JPG + layered PSD.',
    clientNotes: 'Arabic copy comes from Mariam’s team; do not translate in-house.',
    po: alNoorPo(y, m, 2), price: count * 1200, requiresPmQa: false,
    deadline: wdDate(y, m, -2), pm: 'daniel',
    triageAt: wd(y, m, 1, '09:50'),
    completeBy: (seq) => (m >= 6 && seq % 2 === 0 ? 'client' : 'sales'),
    teams: [{
      dept: 'design', planned: count,
      assignments: [
        {
          who: designers[0], count: half, base: 'Design', title: `Feed posts 01–${String(half).padStart(2, '0')}`,
          instructions: 'Feed posts from the content calendar. Use the photography in /AlNoor/Stills; price cards per the latest price list.',
          kind: (seq) => (seq % 3 === 0 ? 'story' : 'post'), start: wds[1], end: wds[Math.min(14, wds.length - 3)], unitHours: 3,
          reference: m === 1 ? asset('reference-moodboard.jpg', 'AlNoor_Moodboard_2026') : undefined,
        },
        {
          who: designers[1], count: count - half, base: 'Design', title: `Stories and carousels ${String(half + 1).padStart(2, '0')}–${String(count).padStart(2, '0')}`,
          instructions: 'Stories and carousel frames. Keep text out of the top and bottom 250 px.',
          kind: (seq) => (seq % 2 === 0 ? 'story' : seq % 5 === 0 ? 'thumb' : 'post'), start: wds[2], end: wds[Math.min(15, wds.length - 2)], unitHours: 3,
        },
      ],
    }],
  };
}

function alNoorSeo(y: number, m: number): ProjectSpec {
  const p = period(y, m);
  const wds = baseWorkdays(y, m);
  return {
    key: `alnoor-${y}-${m}-seo`, client: 'alnoor', y, m,
    title: `SEO Monthly Retainer — ${p.label}`, projectType: 'SEO retainer',
    objective: 'Grow organic enquiries for the priority communities: ranking report, on-page optimisation and a long-form article.',
    description: 'Keyword tracking for 120 terms, on-page work on six pages, one 1,200-word article.',
    requirements: 'Report as PDF with month-on-month comparison. Article in English; the client translates. Internal links to at least three project pages.',
    po: alNoorPo(y, m, 3), price: 8500, requiresPmQa: false,
    deadline: wdDate(y, m, -1), pm: 'daniel',
    triageAt: wd(y, m, 1, '10:05'),
    teams: [{
      dept: 'seo', planned: 3,
      assignments: [
        { who: 'imran', count: 1, base: 'Ranking Report', title: 'Keyword ranking report', instructions: 'Rank tracking for the 120 terms; highlight movers and next steps.', kind: 'seo-report', start: wds[1], end: wds[6], unitHours: 6 },
        { who: 'imran', count: 1, base: 'On-page Optimisation', title: 'On-page optimisation (6 pages)', instructions: 'Titles, metas, H1s and internal links for the six pages in the brief.', kind: 'onpage', start: wds[4], end: wds[14], unitHours: 10 },
        { who: 'hannah', count: 1, base: 'Blog Article', title: 'Long-form article', instructions: 'Topic from the content plan; 1,200+ words; three internal links; meta description.', kind: 'blog', start: wds[3], end: wds[13], unitHours: 7 },
      ],
    }],
  };
}

function alNoorSocial(y: number, m: number): ProjectSpec {
  const p = period(y, m);
  const wds = baseWorkdays(y, m);
  return {
    key: `alnoor-${y}-${m}-social`, client: 'alnoor', y, m,
    title: `Community Management & Content Calendar — ${p.label}`, projectType: 'Social media management',
    objective: 'Plan the month’s posting calendar and manage the Instagram, TikTok and LinkedIn communities.',
    description: 'Content calendar at the start of the month; community management throughout; performance report at month end.',
    requirements: 'Calendar approved by Mariam before the 3rd. Replies within 2 hours during business hours; escalate sales leads to the Al Noor call centre.',
    po: alNoorPo(y, m, 4), price: 6500, requiresPmQa: false,
    deadline: wdDate(y, m, -1), pm: 'daniel',
    triageAt: wd(y, m, 1, '10:15'),
    teams: [{
      dept: 'social', planned: 2,
      assignments: [
        { who: 'aisha', count: 1, base: 'Content Calendar', title: 'Content calendar', instructions: 'Month plan across Instagram, TikTok and LinkedIn aligned with the video and design deliverables.', kind: 'calendar', start: wds[0], end: wds[3], unitHours: 8 },
        { who: 'aisha', count: 1, base: 'Community Report', title: 'Community management + monthly report', instructions: 'Daily community management; report on growth, engagement and leads.', kind: 'community', start: wds[1], end: wds[wds.length - 2], unitHours: 26 },
      ],
    }],
  };
}

function alNoorWebsite(y: number, m: number, title: string, devCount: number, designCount: number, price: number): ProjectSpec {
  const wds = baseWorkdays(y, m);
  const devs = devCount > 2 ? ['kevin', 'rohan'] : ['kevin'];
  return {
    key: `alnoor-${y}-${m}-website`, client: 'alnoor', y, m,
    title, projectType: 'Website update',
    objective: 'Update alnoor-realestate.example with new landing pages for the current launch.',
    description: 'Design and build of campaign landing pages on the existing WordPress theme, with lead forms into the CRM.',
    requirements: 'Mobile-first; Lighthouse ≥ 90; forms to the Salesforce web-to-lead endpoint; Arabic RTL versions.',
    po: alNoorPo(y, m, 5), price, requiresPmQa: true, priority: 'high',
    deadline: wdDate(y, m, -3), pm: 'daniel',
    triageAt: wd(y, m, 5, '14:00'),
    teams: [
      {
        dept: 'design', planned: designCount,
        assignments: [{ who: 'sara', count: designCount, base: 'Page Design', title: 'Landing page designs (desktop + mobile)', instructions: 'Figma designs from the approved wireframe; export PNGs for review.', kind: 'web', start: wds[5], end: wds[9], unitHours: 8 }],
      },
      {
        dept: 'development', planned: devCount,
        assignments: devs.map((who, i) => ({
          who, count: i === 0 ? devCount - (devs.length - 1) : 1, base: 'Build', title: i === 0 ? 'Build landing pages' : 'Search filters + CRM form',
          instructions: 'Build on staging from the approved designs; share staging links and screenshots.',
          kind: (seq: number) => (seq % 2 === 0 ? 'mobile' : 'web'), start: wds[8], end: wds[16], unitHours: 16,
        })),
      },
    ],
  };
}

function alNoorMonth(y: number, m: number): ProjectSpec[] {
  const cfg = AL_NOOR_MONTHS.find((x) => x.m === m)!;
  return [
    alNoorVideos(y, m, cfg.videos, cfg.editors, cfg.theme),
    alNoorDesigns(y, m, cfg.designs, cfg.designers, cfg.theme),
    alNoorSeo(y, m),
    alNoorSocial(y, m),
  ];
}

function scheduleAlNoor(): void {
  const y = 2026;
  let previous: ProjectSpec[] = [];
  for (const cfg of AL_NOOR_MONTHS) {
    const specs = alNoorMonth(y, cfg.m);
    if (cfg.m === 7) {
      // Video 03 waits for the client, who asks for a change (below).
      specs[0].teams[0].assignments[0].plans = [undefined, undefined,
        { upload: ts('2026-07-08 11:00'), stop: 'delivered', deliverAt: ts('2026-07-13 11:30') }];
    }
    if (cfg.m === 1) {
      sim.spawn(ts('2026-01-05 10:15'), 'file Al Noor January', async () => {
        for (const spec of specs) {
          spec.brief = [
            ['Background', 'Al Noor is launching Marina Heights (Tower A) and needs a steady monthly presence across Instagram, TikTok and LinkedIn.'],
            ['Audience', 'End users (families, 30-45) and GCC/European investors; Arabic and English.'],
            ['Tone', 'Premium but warm; real residents and real views, no stock footage.'],
            ['Mandatories', 'RERA permit number, gold lockup, price from the current list only.'],
          ];
          await fileSpec({ ...spec, triageAt: null });
        }
        for (const spec of specs) scheduleProject({ ...spec, triageAt: ts('2026-01-05 14:00') });
      });
    } else {
      const [py, pm] = prevMonth(y, cfg.m);
      scheduleCopy(wd(py, pm, -4, '11:20'), 'alnoor', [py, pm], specs, previous.map((s) => s.key));
    }
    if (cfg.m === 3) {
      const web = alNoorWebsite(y, 3, 'Website Update — Ramadan Offers Landing Page', 2, 1, 14500);
      sim.spawn(wd(y, 3, 4, '12:30'), 'file Al Noor website March', async () => { await fileSpec(web); scheduleProject(web); });
    }
    if (cfg.m === 6) {
      const web = alNoorWebsite(y, 6, 'Website Update — Property Search Filters', 3, 1, 18000);
      sim.spawn(wd(y, 6, 4, '12:30'), 'file Al Noor website June', async () => { await fileSpec(web); scheduleProject(web); });
    }
    previous = specs;
    const [ny, nm] = nextMonth(y, cfg.m);
    scheduleClose(wd(ny, nm, 3, '16:30'), 'alnoor', y, cfg.m);
    if (cfg.m <= 7) {
      scheduleInvoice('alnoor', y, cfg.m, wd(ny, nm, 1, '11:05'), cfg.m === 3 ? null : wd(ny, nm, int(13, 17), '12:00'));
    } else {
      scheduleInvoice('alnoor', y, cfg.m, wd(ny, nm, 1, '11:05'), null);
    }
  }

  // March invoice: issued against the wrong PO, voided and reissued (brief §29 invoices).
  sim.spawn(wd(2026, 4, 3, '09:40'), 'void Al Noor March invoice', async () => {
    const omar = actor('omar');
    await A.void(omar, reg.invoices.get(monthKey('alnoor', 2026, 3))!, 'Issued against the wrong PO number (ANRE/PO/2026/009 instead of ANRE/PO/2026/013). Reissued with the correct reference.');
    const id = await A.draftInvoice(omar, reg.months.get(monthKey('alnoor', 2026, 3))!);
    await A.issue(omar, id);
    reg.invoices.set(monthKey('alnoor', 2026, 3), id);
    sim.spawn(wd(2026, 4, 17, '12:00'), 'paid Al Noor March', async () => A.paid(omar, id, dubaiDate(sim.now)));
  });

  // July: the client asks for a change to Video 03 in the portal; Sales opens Revision #01.
  const jul = 'alnoor-2026-7-videos';
  sim.spawn(ts('2026-07-14 09:20'), 'Al Noor July change request', async () => {
    const s = slot(jul, 'video', 3);
    await A.clientDecision(portalActor('alnoor'), deliveryOf(s.id), 'changes_requested',
      'Please update the starting price on the end card to AED 1.35M — the July price list changed.');
    await sim.at(ts('2026-07-14 11:05'));
    const rev = await A.openRevision(actor('omar'), {
      projectId: project(jul).id, title: 'End-card price update', priority: 'high', deadline: day('2026-07-16'),
      clientFeedback: 'Please update the starting price on the end card to AED 1.35M — the July price list changed.',
      details: 'Only the end card changes. Keep everything else as delivered.', deliverableIds: [s.id],
    });
    await sim.at(ts('2026-07-14 12:10'));
    await A.handRevision(actor('hassan'), rev.revisionId, s.id, 'ahmed', day('2026-07-16'));
    await sim.at(ts('2026-07-15 10:40'));
    await A.upload(actor('ahmed'), s.id, fileFor('reel', { client: 'alnoor', clientName: 'Al Noor Real Estate', period: period(2026, 7), slotName: s.name, seq: s.seq, version: 2, dept: 'video' }), 'End card updated to “from AED 1.35M”.');
    await sim.at(ts('2026-07-15 12:30'));
    await A.review(actor('hassan'), s.id, 'approved', 'Price updated. Approved.');
    await sim.at(ts('2026-07-15 15:10'));
    await A.review(actor('daniel'), s.id, 'approved', 'PM approved.');
    await sim.at(ts('2026-07-16 10:20'));
    await A.delivery(actor('omar'), deliveryOf(s.id), 'delivered', { notes: 'Sent the corrected cut via WeTransfer link' });
    await sim.at(ts('2026-07-17 09:45'));
    await A.clientDecision(portalActor('alnoor'), deliveryOf(s.id), 'approved');
    await sim.at(ts('2026-07-17 11:30'));
    await A.endRevision(actor('omar'), rev.revisionId, 'closed');
  });
}

/* =========================================================== Oasis Dental == */

function oasisSeo(y: number, m: number): ProjectSpec {
  const p = period(y, m);
  const wds = baseWorkdays(y, m);
  return {
    key: `oasis-${y}-${m}-seo`, client: 'oasis', y, m,
    title: `Local SEO — ${p.label}`, projectType: 'Local SEO',
    objective: 'More appointment calls and direction requests from Google Maps for the three clinics.',
    description: 'Google Business Profile optimisation, citation clean-up and location-page copy.',
    requirements: 'DHA advertising rules apply: no guarantees, no unconsented patient photos. Medical claims approved by Dr. Leena.',
    po: `ODC-${y}${String(m).padStart(2, '0')}-SEO`, price: 7500, requiresPmQa: false,
    deadline: wdDate(y, m, -1), pm: 'fatima', triageAt: wd(y, m, 1, '10:30'),
    teams: [{
      dept: 'seo', planned: 3,
      assignments: [
        { who: 'imran', count: 1, base: 'GBP Report', title: 'Google Business Profile optimisation', instructions: 'All three profiles: categories, photos, Q&A, review replies; report results.', kind: 'gbp', start: wds[1], end: wds[8], unitHours: 7 },
        { who: 'imran', count: 1, base: 'Citation Audit', title: 'Citation audit', instructions: 'Check NAP consistency across the top UAE directories and fix what we can.', kind: 'citations', start: wds[6], end: wds[15], unitHours: 5 },
        { who: 'hannah', count: 1, base: 'Location Page', title: 'Location page copy', instructions: 'One location page per month; 600-800 words; DHA-compliant.', kind: 'location', start: wds[3], end: wds[13], unitHours: 6 },
      ],
    }],
  };
}

function oasisSocial(y: number, m: number): ProjectSpec {
  const p = period(y, m);
  const wds = baseWorkdays(y, m);
  return {
    key: `oasis-${y}-${m}-social`, client: 'oasis', y, m,
    title: `Social Media — ${p.label}`, projectType: 'Social media management',
    objective: 'An educational, friendly Instagram presence that books consultations.',
    description: 'Monthly calendar, community management and four designed posts.',
    requirements: 'Four feed posts 1080×1350 in the teal palette; no before/after photos without signed consent.',
    po: `ODC-${y}${String(m).padStart(2, '0')}-SOC`, price: 9800, requiresPmQa: false,
    deadline: wdDate(y, m, -1), pm: 'fatima', triageAt: wd(y, m, 1, '10:45'),
    teams: [
      {
        dept: 'social', planned: 2,
        assignments: [
          { who: 'aisha', count: 1, base: 'Content Calendar', title: 'Content calendar', instructions: 'Calendar with educational themes; approval from Joanna by the 3rd.', kind: 'calendar', start: wds[0], end: wds[3], unitHours: 6 },
          { who: 'aisha', count: 1, base: 'Community Report', title: 'Community management + report', instructions: 'Reply to comments/DMs; route booking requests to reception.', kind: 'community', start: wds[1], end: wds[wds.length - 2], unitHours: 16 },
        ],
      },
      {
        dept: 'design', planned: 4,
        assignments: [{ who: 'tom', count: 4, base: 'Post', title: 'Feed posts', instructions: 'Four posts from the calendar using the teal template.', kind: 'post', start: wds[2], end: wds[13], unitHours: 3 }],
      },
    ],
  };
}

function scheduleOasis(): void {
  const y = 2026;
  let previous: ProjectSpec[] = [];
  for (let m = 3; m <= 8; m++) {
    const specs = [oasisSeo(y, m), oasisSocial(y, m)];
    if (m === 8) {
      // Post 02 is the one the client briefly wanted changed (below).
      specs[1].teams[1].assignments[0].plans = [undefined,
        { upload: ts('2026-08-12 11:00'), stop: 'delivered', deliverAt: ts('2026-08-13 11:30') }];
    }
    if (m === 3) {
      sim.spawn(ts('2026-03-02 10:05'), 'file Oasis March (won)', async () => {
        const [seoSpec, socialSpec] = specs;
        await fileSpec(seoSpec, { opportunityId: reg.opps.get('oasis-retainer') });
        await fileSpec(socialSpec);
        await updateClient('lina', 'oasis', { startedOn: day('2026-03-01') });
        for (const spec of specs) scheduleProject({ ...spec, triageAt: ts('2026-03-02 14:30') });
      });
    } else {
      const [py, pm] = prevMonth(y, m);
      scheduleCopy(wd(py, pm, -4, '15:10'), 'oasis', [py, pm], specs, previous.map((s) => s.key));
    }
    previous = specs;
    const [ny, nm] = nextMonth(y, m);
    if (m <= 7) scheduleClose(wd(ny, nm, 3, '15:45'), 'oasis', y, m);
    if (m <= 7) scheduleInvoice('oasis', y, m, wd(ny, nm, 1, '10:20'), m <= 6 ? wd(ny, nm, int(15, 19), '11:30') : null);
  }

  // August: a revision the client withdrew the next day (brief §15, cancelled).
  const aug = 'oasis-2026-8-social';
  sim.spawn(ts('2026-08-18 10:10'), 'Oasis August revision', async () => {
    const s = slot(aug, 'design', 2);
    const rev = await A.openRevision(actor('lina'), {
      projectId: project(aug).id, title: 'Replace stock photo on the whitening post', priority: 'normal', deadline: day('2026-08-20'),
      clientFeedback: 'Could we use a photo of our own team instead of the stock image on the whitening post?',
      details: 'Joanna is sending a team photo from the Al Barsha clinic.', deliverableIds: [s.id],
    });
    await sim.at(ts('2026-08-18 11:30'));
    await A.handRevision(actor('maya'), rev.revisionId, s.id, 'tom', day('2026-08-20'));
    await A.comment(actor('tom'), { revisionId: rev.revisionId }, 'Waiting for the team photo from Joanna — will turn it around the same day.');
    await sim.at(ts('2026-08-19 09:50'));
    await A.comment(actor('lina'), { revisionId: rev.revisionId }, 'Joanna called: Dr. Leena prefers the original after all. Cancelling this one.');
    await A.endRevision(actor('lina'), rev.revisionId, 'cancelled');
    await sim.at(ts('2026-08-20 15:10'));
    await A.delivery(actor('lina'), deliveryOf(s.id), 'completed', { clientFeedback: 'Posted as delivered.' });
  });
}

/* ========================================================= Desert Bloom == */

function dbSocial(y: number, m: number): ProjectSpec {
  const p = period(y, m);
  const wds = baseWorkdays(y, m);
  return {
    key: `desertbloom-${y}-${m}-social`, client: 'desertbloom', y, m,
    title: `Social Media Management — ${p.label}`, projectType: 'Social media management',
    objective: 'Keep all six cafés busy on weekday afternoons through Instagram and TikTok.',
    description: 'Monthly content calendar and a caption pack in English and Arabic; community management throughout.',
    requirements: 'Calendar approved by Rania by the 3rd working day. Tone: warm and playful; no discount language.',
    po: `DB-${y}-${String(m).padStart(2, '0')}-SM`, price: 6000, requiresPmQa: false,
    deadline: wdDate(y, m, -1), pm: 'fatima', triageAt: wd(y, m, 1, '11:10'),
    teams: [{
      dept: 'social', planned: 2,
      assignments: [
        { who: 'layla', count: 1, base: 'Content Calendar', title: 'Content calendar', instructions: 'Menu launches first; one UGC repost per week.', kind: 'calendar', start: wds[0], end: wds[3], unitHours: 7 },
        { who: 'layla', count: 1, base: 'Caption Pack', title: 'Caption pack (EN/AR)', instructions: 'Captions for every calendar slot; Arabic by the translator.', kind: 'captions', start: wds[2], end: wds[8], unitHours: 6 },
      ],
    }],
  };
}

function dbDesigns(y: number, m: number): ProjectSpec {
  const p = period(y, m);
  const wds = baseWorkdays(y, m);
  return {
    key: `desertbloom-${y}-${m}-designs`, client: 'desertbloom', y, m,
    title: `Menu & Promo Designs — ${p.label}`, projectType: 'Print and social design',
    objective: 'Menu boards and promo artwork for this month’s specials across six cafés.',
    description: 'Six designs: digital menu boards (1920×1080) and feed posts.',
    requirements: 'Print-ready PDF for boards (CMYK), JPG for social. Prices from the menu sheet only.',
    po: `DB-${y}-${String(m).padStart(2, '0')}-DS`, price: 7200, requiresPmQa: false,
    deadline: wdDate(y, m, -2), pm: 'fatima', triageAt: wd(y, m, 1, '11:20'),
    teams: [{
      dept: 'design', planned: 6,
      assignments: [{ who: 'tom', count: 6, base: 'Design', title: 'Menu boards + promo posts', instructions: 'Use the autumn palette; check every price against the menu sheet.', kind: 'post', start: wds[2], end: wds[15], unitHours: 3 }],
    }],
  };
}

function dbReels(y: number, m: number): ProjectSpec {
  const p = period(y, m);
  const wds = baseWorkdays(y, m);
  return {
    key: `desertbloom-${y}-${m}-reels`, client: 'desertbloom', y, m,
    title: `Café Reels — ${p.label}`, projectType: 'Social media videos',
    objective: 'Three reels showing the month’s specials being made.',
    description: 'Shot in the Al Wasl café on the first Monday; one hero drink, one food item, one barista feature.',
    requirements: '9:16, 15–25 s, trending-safe licensed audio, captions burned in.',
    po: `DB-${y}-${String(m).padStart(2, '0')}-RL`, price: 10500, requiresPmQa: true,
    deadline: wdDate(y, m, -2), pm: 'fatima', triageAt: wd(y, m, 1, '11:30'),
    teams: [{
      dept: 'video', planned: 3,
      assignments: [{ who: 'bilal', count: 3, base: 'Reel', title: 'Shoot + edit café reels', instructions: 'Shoot day at Al Wasl; macro shots of the pour; captions burned in.', kind: 'reel', start: wds[2], end: wds[15], unitHours: 8 }],
    }],
  };
}

function scheduleDesertBloom(): void {
  const y = 2026;
  let previous: ProjectSpec[] = [];
  for (let m = 5; m <= 8; m++) {
    const specs = [dbSocial(y, m), dbDesigns(y, m), dbReels(y, m)];
    if (m === 8) {
      // Design 03 is the menu board with the price typo (below).
      specs[1].teams[0].assignments[0].plans = [undefined, undefined,
        { upload: ts('2026-08-19 11:15'), stop: 'delivered', deliverAt: ts('2026-08-21 11:20') }];
    }
    if (m === 5) {
      sim.spawn(ts('2026-05-04 12:15'), 'file Desert Bloom May (won)', async () => {
        await fileSpec(specs[0], { opportunityId: reg.opps.get('desertbloom-retainer') });
        await fileSpec(specs[1]);
        await fileSpec(specs[2]);
        await updateClient('lina', 'desertbloom', { startedOn: day('2026-05-01') });
        for (const spec of specs) scheduleProject({ ...spec, triageAt: ts('2026-05-05 09:40') });
      });
    } else {
      const [py, pm] = prevMonth(y, m);
      scheduleCopy(wd(py, pm, -3, '14:40'), 'desertbloom', [py, pm], specs, previous.map((s) => s.key));
    }
    previous = specs;
    const [ny, nm] = nextMonth(y, m);
    scheduleClose(wd(ny, nm, 3, '17:05'), 'desertbloom', y, m);
    scheduleInvoice('desertbloom', y, m, wd(ny, nm, 1, '10:40'), m <= 7 ? wd(ny, nm, int(12, 16), '15:20') : null);
  }

  // August: Lina ticks "Repeats every month" on the social retainer (brief §29 recurring).
  sim.spawn(ts('2026-08-05 16:20'), 'Desert Bloom recurring', async () => {
    await A.editDetails(actor('lina'), project('desertbloom-2026-8-social').id, { recursMonthly: true });
  });

  // August: a price typo on a menu board, fixed through a revision and closed.
  const aug = 'desertbloom-2026-8-designs';
  sim.spawn(ts('2026-08-24 10:30'), 'Desert Bloom August revision', async () => {
    const s = slot(aug, 'design', 3);
    const rev = await A.openRevision(actor('lina'), {
      projectId: project(aug).id, title: 'Menu board price correction', priority: 'urgent', deadline: day('2026-08-24'),
      clientFeedback: 'The Iced Spanish Latte should be AED 22, not AED 26 — the boards go live tomorrow.',
      details: 'Only the price changes. Please also re-export the print PDF.', deliverableIds: [s.id],
    });
    await sim.at(ts('2026-08-24 11:00'));
    await A.handRevision(actor('maya'), rev.revisionId, s.id, 'tom', day('2026-08-24'));
    await sim.at(ts('2026-08-24 12:20'));
    await A.upload(actor('tom'), s.id, fileFor('post', { client: 'desertbloom', clientName: 'Desert Bloom Cafés', period: period(2026, 8), slotName: s.name, seq: s.seq, version: 2, dept: 'design' }), 'Price corrected to AED 22.');
    await sim.at(ts('2026-08-24 13:05'));
    await A.review(actor('maya'), s.id, 'approved', 'Checked against the menu sheet. Approved.');
    await sim.at(ts('2026-08-24 14:00'));
    await A.delivery(actor('lina'), deliveryOf(s.id), 'delivered', { notes: 'Sent to Rania on WhatsApp + WeTransfer' });
    await sim.at(ts('2026-08-25 10:15'));
    await A.delivery(actor('lina'), deliveryOf(s.id), 'completed', { clientFeedback: 'Boards printed and installed.' });
    await A.endRevision(actor('lina'), rev.revisionId, 'closed');
  });
}

/* ======================================================= helpers, clients == */

async function updateClient(who: string, client: ClientKey, patch: Partial<ClientProfile>): Promise<void> {
  const clientId = reg.clients.get(client)!;
  const [row] = await sql<{
    name: string; company_name: string | null; status: ClientProfile['status']; client_type: ClientProfile['clientType'];
    started_on: string | null; notes: string | null;
  }[]>`SELECT name, company_name, status::text AS status, client_type::text AS client_type,
              started_on::text AS started_on, notes FROM clients WHERE id = ${clientId}`;
  const r = await updateClientProfile(actor(who), {
    clientId,
    profile: {
      name: row.name, companyName: row.company_name, status: row.status, clientType: row.client_type,
      startedOn: row.started_on, notes: row.notes, ...patch,
    },
  });
  if (r.changed.length > 0) {
    await recordActivity({
      actorId: actor(who).id, action: 'client.updated', entityType: 'client', entityId: clientId, clientId, metadata: { fields: r.changed },
    });
  }
}

async function createClientRecord(c: ClientSeed): Promise<number> {
  const owner = actor(c.owner);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO clients (name, company_name, client_type, status, notes, owner_user_id, created_by)
    VALUES (${c.name}, ${c.company}, ${c.type}, ${c.prospect ? 'prospect' : 'active'}, ${c.notes},
            ${owner.role === 'sales' ? owner.id : null}, ${owner.id})
    RETURNING id`;
  const id = Number(row.id);
  reg.clients.set(c.key, id);
  await recordActivity({ actorId: owner.id, action: 'client.created', entityType: 'client', entityId: id, clientId: id, metadata: { name: c.name } });
  for (const contact of c.contacts) {
    await saveContact(owner, {
      clientId: id,
      contact: { name: contact.name, email: contact.email, phone: contact.phone, jobTitle: contact.title, isPrimary: contact.primary ?? false },
    });
    await recordActivity({ actorId: owner.id, action: 'client.contact_added', entityType: 'client', entityId: id, clientId: id, metadata: { name: contact.name } });
  }
  const services = c.services.map((s) => DEPT[s]);
  for (const departmentId of services) {
    await sql`INSERT INTO client_services (client_id, department_id) VALUES (${id}, ${departmentId})`;
  }
  await recordActivity({ actorId: owner.id, action: 'client.services_changed', entityType: 'client', entityId: id, clientId: id, metadata: { departmentIds: services } });
  if (c.startedOn && !c.prospect) await updateClient(c.owner, c.key, { startedOn: day(c.startedOn) });
  return id;
}

/* ========================================================== the company == */

async function scheduleCompany(): Promise<void> {
  const hashes = new Map<string, string>();
  for (const p of PEOPLE) hashes.set(p.key, await hashPassword(PASSWORD));
  const depts = await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM departments`;
  for (const d of depts) DEPT[d.slug] = Number(d.id);

  const insertUser = async (p: Person, by: number | null) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, full_name, role, must_change_password)
      VALUES (${p.email}, ${hashes.get(p.key)!}, ${p.name}, ${p.role}, true) RETURNING id`;
    ID[p.key] = Number(row.id);
    if (by === null) {
      await recordActivity({ actorId: ID[p.key], action: 'user.seeded', entityType: 'user', entityId: ID[p.key], metadata: { via: 'seed script' } });
    } else {
      await recordActivity({ actorId: by, action: 'user.created', entityType: 'user', entityId: ID[p.key], metadata: { email: p.email, role: p.role } });
    }
    if (p.dept) {
      const departmentId = DEPT[p.dept];
      await sql`INSERT INTO department_members (user_id, department_id, is_lead) VALUES (${ID[p.key]}, ${departmentId}, ${p.lead ?? false})`;
      await recordActivity({
        actorId: by ?? ID[p.key], action: 'user.departments_changed', entityType: 'user', entityId: ID[p.key],
        metadata: { memberOf: [departmentId], leadOf: p.lead ? [departmentId] : [] },
      });
    }
  };
  /** They chose their own password at first sign-in (the demo password). */
  const firstLogin = async (p: Person) => {
    await sql`UPDATE users SET must_change_password = false WHERE id = ${ID[p.key]}`;
    await recordActivity({ actorId: ID[p.key], action: 'user.password_changed', entityType: 'user', entityId: ID[p.key] });
  };

  sim.spawn(ts('2025-12-29 09:00'), 'people', async () => {
    const admin = PEOPLE[0];
    await insertUser(admin, null);
    await firstLogin(admin);
    let t = ts('2025-12-29 09:20');
    for (const p of PEOPLE.slice(1)) {
      if (p.joined) continue;
      await sim.at(t);
      await insertUser(p, ID.admin);
      t = new Date(t.getTime() + int(3, 9) * 60_000);
    }
    for (const p of PEOPLE) if (ID[p.key]) await loadActor(p.key);
    await sim.at(ts('2025-12-29 11:40'));
    const grants: [string, 'view_pricing' | 'export_reports' | 'reopen_month'][] = [
      ['hassan', 'view_pricing'], ['lina', 'export_reports'], ['daniel', 'reopen_month'],
    ];
    for (const [key, permission] of grants) {
      await sql`INSERT INTO user_permissions (user_id, permission, granted_by) VALUES (${ID[key]}, ${permission}, ${ID.admin})`;
      await recordActivity({ actorId: ID.admin, action: 'user.permissions_changed', entityType: 'user', entityId: ID[key], metadata: { granted: [permission] } });
      await loadActor(key);
    }
    // Everyone signs in on the first working day of January.
    let s = ts('2026-01-02 08:40');
    for (const p of PEOPLE.slice(1)) {
      if (p.joined) continue;
      await sim.at(s);
      await firstLogin(p);
      s = new Date(s.getTime() + int(2, 11) * 60_000);
    }
  });

  // Billing details and hourly costs (brief §29).
  sim.spawn(ts('2026-01-02 10:05'), 'billing settings', async () => {
    const ceo = actor('ceo');
    await updateBillingSettings(ceo, {
      companyName: 'Aktivacity FZ-LLC',
      companyAddress: 'Office 1204, Loft Office 2, Dubai Media City\nPO Box 502931, Dubai, United Arab Emirates',
      taxRegistration: '100384729100003', defaultVatRate: 5, paymentTermsDays: 30,
      paymentDetails: 'Emirates NBD — Account name: Aktivacity FZ-LLC\nIBAN: AE07 0260 0010 1523 4567 801 — SWIFT: EBILAEAD\nAccount no. 1015234567801 (AED)',
      footerNote: 'Thank you for your business. Please quote the invoice number with your payment.',
    });
    await recordActivity({ actorId: ceo.id, action: 'billing.settings_changed', entityType: 'billing_settings', entityId: 1 });
    await sim.at(ts('2026-01-02 10:30'));
    for (const p of PEOPLE) {
      if (!p.rate || p.joined) continue;
      await setCostRate(ceo, { userId: ID[p.key], effectiveFrom: day('2026-01-01'), hourlyCost: p.rate, currency: 'AED' });
      await recordActivity({ actorId: ceo.id, action: 'user.cost_rate_set', entityType: 'user', entityId: ID[p.key], metadata: { effectiveFrom: day('2026-01-01') } });
    }
  });

  // New joiners, a raise and a leaver.
  for (const p of PEOPLE.filter((x) => x.joined)) {
    sim.spawn(ts(`${p.joined} 08:45`), `joiner ${p.key}`, async () => {
      await insertUser(p, ID.admin);
      await loadActor(p.key);
      await sim.at(ts(`${p.joined} 09:30`));
      await firstLogin(p);
      await sim.at(ts(`${p.joined} 10:15`));
      await setCostRate(actor('ceo'), { userId: ID[p.key], effectiveFrom: day(p.joined!), hourlyCost: p.rate!, currency: 'AED' });
      await recordActivity({ actorId: ID.ceo, action: 'user.cost_rate_set', entityType: 'user', entityId: ID[p.key], metadata: { effectiveFrom: day(p.joined!) } });
    });
  }
  sim.spawn(ts('2026-06-29 16:10'), 'raise for Ahmed', async () => {
    await setCostRate(actor('ceo'), { userId: ID.ahmed, effectiveFrom: day('2026-07-01'), hourlyCost: 85, currency: 'AED' });
    await recordActivity({ actorId: ID.ceo, action: 'user.cost_rate_set', entityType: 'user', entityId: ID.ahmed, metadata: { effectiveFrom: day('2026-07-01') } });
  });
  sim.spawn(ts('2026-04-10 17:20'), 'leaver James', async () => {
    await sql`UPDATE users SET is_active = false, deactivated_at = now() WHERE id = ${ID.james}`;
    await recordActivity({ actorId: ID.admin, action: 'user.updated', entityType: 'user', entityId: ID.james, metadata: { role: 'executive', isActive: false } });
    await loadActor('james');
  });

  // Clients appear when they are first booked.
  for (const c of CLIENTS) {
    sim.spawn(ts(c.created), `client ${c.key}`, async () => { await createClientRecord(c); });
  }
}

/* =============================================================== pipeline == */

function schedulePipeline(): void {
  const opp = (key: string, at: string, owner: 'omar' | 'lina', client: ClientKey, title: string, value: number, close: string, notes: string, moves: [string, Stage][] = []) => {
    sim.spawn(ts(at), `opportunity ${key}`, async () => {
      const id = await A.opportunity(actor(owner), {
        clientId: reg.clients.get(client)!, title, stage: 'lead', estimatedValue: value, expectedClose: day(close), notes,
      });
      reg.opps.set(key, id);
      for (const [when, stage] of moves) {
        sim.spawn(ts(when), `stage ${key} ${stage}`, async () => A.stage(actor(owner), reg.opps.get(key)!, stage));
      }
    });
  };
  opp('oasis-retainer', '2026-02-09 11:20', 'lina', 'oasis', 'Local SEO + social media retainer', 17300 * 3, '2026-03-01',
    'Three clinics. Wants more Maps calls; unhappy with the current agency’s reporting.',
    [['2026-02-16 10:00', 'qualified'], ['2026-02-20 15:30', 'proposal'], ['2026-02-25 12:10', 'negotiation']]);
  opp('desertbloom-retainer', '2026-04-06 14:45', 'lina', 'desertbloom', 'Social media + café reels retainer', 23700 * 3, '2026-05-01',
    'Six cafés; autumn menu is their biggest launch of the year.',
    [['2026-04-14 11:00', 'proposal'], ['2026-04-22 16:00', 'negotiation']]);
  opp('padel', '2026-05-18 10:05', 'omar', 'padel', 'Tournament coverage (June open)', 22000, '2026-06-05',
    'Two-day tournament; highlights within 24 hours.', [['2026-05-21 12:00', 'proposal']]);
  sim.spawn(ts('2026-06-02 11:15'), 'padel lost', async () => A.lost(actor('omar'), reg.opps.get('padel')!, 'Went with their in-house media team to save budget.'));
  opp('falcon-website', '2026-07-08 11:00', 'lina', 'falcon', 'Corporate website rebuild', 85000, '2026-08-31',
    'Current site is 2014 WordPress; tracking page breaks weekly. Decision by the CEO.',
    [['2026-07-21 10:30', 'qualified'], ['2026-08-05 16:40', 'proposal'], ['2026-08-19 11:20', 'negotiation']]);
  opp('gulf-film', '2026-07-20 12:30', 'omar', 'gulf', 'Brand film 2026', 72000, '2026-08-03',
    'Hero film across four properties plus cutdowns and key art.', [['2026-07-22 15:00', 'proposal'], ['2026-07-28 10:40', 'negotiation']]);
  opp('crescent', '2026-08-12 10:15', 'lina', 'crescent', 'Social media pilot (3 months)', 54000, '2026-10-01',
    '22 branches; wants health-awareness content and store openings.',
    [['2026-08-18 09:45', 'qualified'], ['2026-08-26 14:10', 'proposal'], ['2026-09-09 11:30', 'negotiation']]);
  opp('marina-launch', '2026-08-25 15:20', 'omar', 'marina', 'Q4 showroom launch video', 36000, '2026-09-03',
    'Launch of the new EV line; showroom shoot at night.', [['2026-08-27 10:00', 'proposal']]);
  opp('marina-service', '2026-09-03 11:40', 'omar', 'marina', 'Service centre promo series', 28000, '2026-10-15',
    'Six short service-tips videos for the after-sales team.', [['2026-09-07 12:00', 'qualified']]);
  sim.spawn(ts('2026-09-16 10:40'), 'marina service lost', async () => {
    await A.lost(actor('omar'), reg.opps.get('marina-service')!, 'Budget frozen — the client paused all Q4 marketing spend after a regional restructuring.');
  });
  opp('palmgrove', '2026-09-02 13:00', 'lina', 'palmgrove', 'Sales centre film + digital brochure', 48000, '2026-10-20',
    'Sales centre opens in November; needs film for the screens and an interactive PDF.', [['2026-09-16 15:30', 'qualified']]);
  opp('nimbus', '2026-09-08 16:30', 'omar', 'nimbus', 'Brand launch film & motion toolkit', 68000, '2026-10-10',
    'Series A announcement in November; launch film, logo animation and motion templates for product videos.',
    [['2026-09-11 11:10', 'qualified'], ['2026-09-18 17:05', 'proposal']]);
  opp('summit-coach', '2026-09-10 11:45', 'omar', 'summit', 'Coach profile video series', 27500, '2026-09-18',
    'Five coach profiles for the new season; first paid project, more to follow.', [['2026-09-14 10:20', 'proposal']]);
  opp('alnoor-dubai-hills', '2026-09-07 12:30', 'omar', 'alnoor', 'Dubai Hills launch campaign (Q4)', 78000, '2026-10-05',
    'Launch film, OOH key visuals and a paid social burst for Dubai Hills Phase 3.',
    [['2026-09-10 10:00', 'qualified'], ['2026-09-20 16:45', 'negotiation']]);
  opp('qasr', '2026-09-21 14:40', 'omar', 'qasr', 'Exhibition teaser videos', 35000, '2026-11-01',
    'Three teasers for the winter pearling exhibition; Arabic voice-over.');
}

/* ====================================================== one-off projects == */

function scheduleGulf(): void {
  // August: the brand film.
  const film: ProjectSpec = {
    key: 'gulf-2026-8-film', client: 'gulf', y: 2026, m: 8,
    title: 'Brand Film 2026', projectType: 'Brand film',
    objective: 'A 90-second brand film across the four Gulf Horizon properties, with cutdowns and key art for the booking engine.',
    description: 'Two shoot days (JBR, Palm) plus library footage for Hatta and RAK. Hero film, 30 s and 15 s cutdowns, poster and YouTube thumbnail.',
    requirements: '16:9 master in 4K + 1080p deliverables; 30 s and 15 s cutdowns; licensed score; EN subtitles file. Key art 1920×1080 and 1280×720.',
    clientNotes: 'Legal must see any on-screen offer before it goes live.',
    internalNotes: 'Crew call sheets on the NAS. Drone permit (DCAA) approved for the Palm day.',
    po: 'GHH-MKT-2026-0418', price: 72000, requiresPmQa: true, priority: 'high',
    deadline: '2026-08-27', pm: 'daniel', triageAt: ts('2026-08-04 09:45'),
    poLines: ['1 x 90 s brand film (4K master)', '2 x cutdowns (30 s, 15 s)', '2 x key art (poster, thumbnail)'],
    brief: [
      ['Objective', 'Show that every Gulf Horizon stay feels like a short escape — sea, mountains and desert within 90 minutes of each other.'],
      ['Story', 'One family, four properties, one long weekend. Golden hour throughout.'],
      ['Deliverables', 'Hero film 90 s; 30 s and 15 s cutdowns; poster; YouTube thumbnail.'],
    ],
    kickoff: `Brand film kick-off: shoot days are ${dMon('2026-08-10')} and ${dMon('2026-08-11')}. Ahmed leads the edit, Bilal takes the cutdowns, Zainab the key art.`,
    teams: [
      {
        dept: 'video', planned: 3,
        assignments: [
          { who: 'ahmed', count: 1, base: 'Film', title: 'Hero film edit (90 s)', instructions: 'Edit from both shoot days + library. Score from the approved shortlist; EN subtitles as SRT.', kind: 'film', start: '2026-08-10', end: '2026-08-20', priority: 'high', unitHours: 40,
            plans: [{ upload: ts('2026-08-17 16:20'), lead: ['changes_requested'], deliverAt: ts('2026-08-21 11:40'), completeAt: ts('2026-08-28 12:15') }] },
          { who: 'bilal', count: 2, base: 'Film', title: 'Cutdowns (30 s + 15 s)', instructions: 'Cut down from the approved hero edit; keep the end card.', kind: 'film', start: '2026-08-17', end: '2026-08-21', unitHours: 10,
            plans: [
              { upload: ts('2026-08-19 15:10'), stop: 'delivered', deliverAt: ts('2026-08-21 11:45') },
              { upload: ts('2026-08-20 11:30'), stop: 'delivered', deliverAt: ts('2026-08-21 11:50') },
            ] },
        ],
      },
      {
        dept: 'design', planned: 2,
        assignments: [{ who: 'zainab', count: 2, base: 'Key Art', title: 'Poster + YouTube thumbnail', instructions: 'Frame grabs from the hero edit; logo top-right.', kind: (seq) => (seq === 1 ? 'keyvisual' : 'thumb'), start: '2026-08-17', end: '2026-08-21', unitHours: 5,
          plans: [
            { upload: ts('2026-08-18 14:00'), deliverAt: ts('2026-08-21 11:55'), completeAt: ts('2026-08-28 12:20') },
            { upload: ts('2026-08-19 10:30'), lead: ['changes_requested'], deliverAt: ts('2026-08-21 12:00'), completeAt: ts('2026-08-28 12:25') },
          ] }],
      },
    ],
  };
  sim.spawn(ts('2026-08-03 11:30'), 'file Gulf brand film (won)', async () => {
    await fileSpec(film, { opportunityId: reg.opps.get('gulf-film') });
    await updateClient('omar', 'gulf', { startedOn: day('2026-08-03') });
    scheduleProject(film);
  });
  // Arabic subtitles on the cutdowns: a revision that was delivered but never formally closed.
  sim.spawn(ts('2026-08-24 10:15'), 'Gulf film revision', async () => {
    const v2 = slot(film.key, 'video', 2);
    const v3 = slot(film.key, 'video', 3);
    const omar = actor('omar');
    const rev = await A.openRevision(omar, {
      projectId: project(film.key).id, title: 'Arabic subtitles on the cutdowns', priority: 'high', deadline: day('2026-08-26'),
      clientFeedback: 'Both cutdowns need Arabic subtitles for the GCC paid campaign — same timing as the English.',
      details: 'Translation attached in Nadia’s email. Burn in, bottom-centre, Dubai font.', deliverableIds: [v2.id, v3.id],
    });
    await sim.at(ts('2026-08-24 11:30'));
    await A.handRevision(actor('hassan'), rev.revisionId, v2.id, 'bilal', day('2026-08-26'));
    await A.handRevision(actor('hassan'), rev.revisionId, v3.id, 'bilal', day('2026-08-26'));
    for (const [s, t] of [[v2, '2026-08-25 11:10'], [v3, '2026-08-25 14:40']] as const) {
      await sim.at(ts(t));
      await A.upload(actor('bilal'), s.id, fileFor('film', { client: 'gulf', clientName: 'Gulf Horizon Hotels', period: period(2026, 8), slotName: s.name, seq: s.seq, version: 2, dept: 'video' }), 'Arabic subtitles burned in.');
    }
    await sim.at(ts('2026-08-25 16:30'));
    for (const s of [v2, v3]) await A.review(actor('hassan'), s.id, 'approved', 'Subtitles checked against the translation. Approved.');
    await sim.at(ts('2026-08-26 09:50'));
    for (const s of [v2, v3]) await A.review(actor('daniel'), s.id, 'approved', null);
    await sim.at(ts('2026-08-26 11:20'));
    for (const s of [v2, v3]) await A.delivery(omar, deliveryOf(s.id), 'delivered', { notes: 'Sent via WeTransfer link' });
    await sim.at(ts('2026-08-28 12:30'));
    for (const s of [v2, v3]) await A.delivery(omar, deliveryOf(s.id), 'completed', { clientFeedback: `Campaign live on ${dMon('2026-08-29')}.` });
  });
  scheduleClose(ts('2026-09-02 15:30'), 'gulf', 2026, 8);
  scheduleInvoice('gulf', 2026, 8, ts('2026-09-01 11:40'), ts('2026-09-18 10:05'));

  // September: the Autumn Staycation campaign — Revision #01 closed, #02 open.
  const stay: ProjectSpec = {
    key: 'gulf-2026-9-staycation', client: 'gulf', y: 2026, m: 9,
    title: 'Autumn Staycation Campaign', projectType: 'Social media campaign',
    objective: 'Drive direct bookings for the “stay 3 nights, pay 2” autumn offer across the four properties.',
    description: '30 s hero, 15 s cutdown and 6 s bumper for paid social and YouTube, plus key visual and two statics.',
    requirements: 'Video 9:16 and 16:9 masters; bumper ≤ 6 s; logo top-right, white, 48 px safe margin; offer T&Cs on screen for 2 s.',
    clientNotes: `Offer copy approved by legal on ${dMon('2026-09-01')} — do not paraphrase it.`,
    internalNotes: `Reuse the brand film grade LUT. Sunrise pool footage from the ${dMon('2026-08-30')} pick-up day is on the NAS.`,
    po: 'GHH-MKT-2026-0512', price: 64500, requiresPmQa: true, priority: 'high',
    deadline: '2026-09-26', pm: 'daniel', triageAt: ts('2026-09-02 09:30'),
    poLines: ['1 x 30 s hero video', '1 x 15 s cutdown', '1 x 6 s bumper', '1 x key visual', '2 x social statics', 'Offer landing page copy (SEO)', 'Paid social captions + targeting plan'],
    teams: [
      {
        dept: 'video', planned: 3,
        assignments: [
          { who: 'ahmed', count: 2, base: 'Video', title: 'Staycation hero (30 s) + 15 s cutdown', instructions: 'Grade with the brand-film LUT. Open on the property exteriors; offer card at 0:22.', kind: 'film', start: '2026-09-02', end: '2026-09-11', priority: 'high', unitHours: 16,
            plans: [
              { upload: ts('2026-09-08 16:00'), stop: 'delivered', deliverAt: ts('2026-09-11 11:30') },
              { upload: ts('2026-09-09 12:10'), stop: 'delivered', deliverAt: ts('2026-09-11 11:35') },
            ] },
          { who: 'bilal', count: 1, base: 'Video', title: '6 s bumper', instructions: 'Logo, offer, URL. Six seconds, no more.', kind: 'film', start: '2026-09-07', end: '2026-09-11', unitHours: 6,
            plans: [{ upload: ts('2026-09-09 15:00'), stop: 'delivered', deliverAt: ts('2026-09-11 11:40') }] },
        ],
      },
      {
        dept: 'design', planned: 3,
        assignments: [{ who: 'zainab', count: 3, base: 'Design', title: 'Key visual + two statics', instructions: 'Key visual from the hero frame; statics in 1080×1350.', kind: (seq) => (seq === 1 ? 'keyvisual' : 'post'), start: '2026-09-03', end: '2026-09-10', unitHours: 5,
          reference: asset('reference-moodboard.jpg', 'GulfHorizon_Autumn_Moodboard'),
          plans: [
            { upload: ts('2026-09-07 14:00'), stop: 'delivered', deliverAt: ts('2026-09-11 11:45') },
            { upload: ts('2026-09-08 11:00'), lead: ['changes_requested'], stop: 'delivered', deliverAt: ts('2026-09-11 11:50') },
            { upload: ts('2026-09-08 15:30'), stop: 'delivered', deliverAt: ts('2026-09-11 11:55') },
          ] }],
      },
      {
        dept: 'seo', planned: 1,
        assignments: [{ who: 'hannah', count: 1, base: 'Offer Page Copy', title: 'Offer landing page copy', instructions: 'Copy, title and meta for the booking-engine offer page; FAQ schema.', kind: 'offer-copy', start: '2026-09-03', end: '2026-09-09', unitHours: 6,
          plans: [{ upload: ts('2026-09-08 12:30'), stop: 'delivered', deliverAt: ts('2026-09-11 12:00') }] }],
      },
      {
        dept: 'social', planned: 1,
        assignments: [{ who: 'aisha', count: 1, base: 'Social Pack', title: 'Paid social captions + targeting plan', instructions: 'Captions for each placement and the audience plan for Meta and TikTok.', kind: 'captions', start: '2026-09-03', end: '2026-09-10', unitHours: 6,
          plans: [{ upload: ts('2026-09-09 11:15'), lead: ['changes_requested'], stop: 'delivered', deliverAt: ts('2026-09-11 12:05') }] }],
      },
    ],
    comments: [
      { at: ts('2026-09-02 12:05'), who: 'ahmed', body: `Pulled the brand-film LUT and the ${dMon('2026-08-30')} pick-up footage into the project. First cut ${weekday('2026-09-07')}.` },
      { at: ts('2026-09-02 12:40'), who: 'zainab', body: 'I’ll build the key visual from Ahmed’s hero frame once he has a selects reel — Ahmed, can you drop three stills by Friday?' },
      { at: ts('2026-09-03 10:15'), who: 'ahmed', body: 'Stills are in the shared folder (/GulfHorizon/Autumn/Stills).' },
      { at: ts('2026-09-03 11:30'), who: 'hannah', body: 'I’ll write the offer page around the same “stay 3, pay 2” line as the end card so the ads and the landing page match.' },
      { at: ts('2026-09-03 12:00'), who: 'aisha', body: 'Captions will follow the same hook. Ahmed, once the 15 s cutdown is locked I’ll time the caption variants to it.' },
    ],
  };
  sim.spawn(ts('2026-09-01 10:30'), 'file Gulf staycation', async () => {
    await fileSpec(stay);
    scheduleProject(stay);
  });
  sim.spawn(ts('2026-09-14 10:00'), 'Gulf revision #01', async () => {
    const omar = actor('omar');
    const v1 = slot(stay.key, 'video', 1);
    const v2 = slot(stay.key, 'video', 2);
    const rev = await A.openRevision(omar, {
      projectId: project(stay.key).id, title: 'Shorter opening, warmer grade', priority: 'high', deadline: day('2026-09-17'),
      clientFeedback: 'Shorten the opening to five seconds and warm up the colour grade on the pool scenes.',
      details: 'Applies to the 30 s hero and the 15 s cutdown. Bumper and statics are approved as delivered.',
      deliverableIds: [v1.id, v2.id],
    });
    await sim.at(ts('2026-09-14 11:30'));
    await A.handRevision(actor('hassan'), rev.revisionId, v1.id, 'ahmed', day('2026-09-17'));
    await A.handRevision(actor('hassan'), rev.revisionId, v2.id, 'ahmed', day('2026-09-17'));
    await A.comment(actor('hassan'), { revisionId: rev.revisionId }, 'Ahmed — keep the pool shots but lift the whites; see the brand film at 0:41 for the target look.');
    for (const [s, t] of [[v1, '2026-09-15 15:05'], [v2, '2026-09-15 17:10']] as const) {
      await sim.at(ts(t));
      await A.upload(actor('ahmed'), s.id, fileFor('film', { client: 'gulf', clientName: 'Gulf Horizon Hotels', period: period(2026, 9), slotName: s.name, seq: s.seq, version: 2, dept: 'video' }), 'Opening trimmed to 5 s; warmer grade on the pool scenes.');
    }
    await sim.at(ts('2026-09-16 10:00'));
    for (const s of [v1, v2]) await A.review(actor('hassan'), s.id, 'approved', 'Much better. Approved.');
    await sim.at(ts('2026-09-16 14:05'));
    for (const s of [v1, v2]) await A.review(actor('daniel'), s.id, 'approved', 'PM approved — matches the feedback.');
    await sim.at(ts('2026-09-16 16:30'));
    for (const s of [v1, v2]) await A.delivery(omar, deliveryOf(s.id), 'delivered', { notes: 'Sent via WeTransfer link' });
    await sim.at(ts('2026-09-17 12:00'));
    for (const seq of [1, 2, 3]) await A.delivery(omar, deliveryOf(slot(stay.key, 'video', seq).id), 'completed', { clientFeedback: `Nadia approved the set; ads live from ${dMon('2026-09-18')}.` });
    for (const seq of [1, 2, 3]) await A.delivery(omar, deliveryOf(slot(stay.key, 'design', seq).id), 'completed', { clientFeedback: 'Approved.' });
    for (const dept of ['seo', 'social'] as const) await A.delivery(omar, deliveryOf(slot(stay.key, dept, 1).id), 'completed', { clientFeedback: 'Approved by Nadia.' });
    await A.endRevision(omar, rev.revisionId, 'closed');
  });
  sim.spawn(ts('2026-09-22 15:40'), 'Gulf revision #02', async () => {
    const omar = actor('omar');
    const v1 = slot(stay.key, 'video', 1);
    const d1 = slot(stay.key, 'design', 1);
    const rev = await A.openRevision(omar, {
      projectId: project(stay.key).id, title: 'New opening scene + logo placement', priority: 'urgent', deadline: day('2026-09-26'),
      clientFeedback: 'Please change the opening scene and update the logo placement.',
      details: 'Nadia wants to open on the infinity pool at sunrise instead of the lobby, and the Gulf Horizon logo moved to the top-right with a 48 px safe margin (white version). Applies to the 30 s hero and the key visual. Markup attached.',
      deliverableIds: [v1.id, d1.id],
    });
    await A.attach(omar, { projectId: project(stay.key).id, revisionId: rev.revisionId }, asset('markup-feedback.png', 'GulfHorizon_Staycation_Markup_R2'));
    await A.attach(omar, { projectId: project(stay.key).id, revisionId: rev.revisionId }, pdf(`Client_Feedback_${dMon('2026-09-22').replace(' ', '')}`, {
      title: 'Client feedback - Revision #02', subtitle: 'Gulf Horizon Hotels - Autumn Staycation Campaign', accent: [150, 70, 60],
      meta: [['From', 'Nadia Farouk, Director of Marketing'], ['Received', `${dMonth('2026-09-22')}, by phone and email`], ['Taken by', 'Omar Haddad']],
      blocks: [
        { h: 'Requested changes' },
        { li: `Open on the infinity pool at sunrise (${dMon('2026-08-30')} footage) instead of the lobby.` },
        { li: 'Logo: top-right, white version, 48 px safe margin - on the hero video and the key visual.' },
        { h: 'Unchanged' },
        { p: 'Offer copy, music and end card stay as approved. The 15 s cutdown and bumper are not affected.' },
      ],
    }));
    await sim.at(ts('2026-09-23 09:30'));
    await A.handRevision(actor('hassan'), rev.revisionId, v1.id, 'ahmed', day('2026-09-26'));
    await sim.at(ts('2026-09-23 10:00'));
    await A.handRevision(actor('maya'), rev.revisionId, d1.id, 'zainab', day('2026-09-26'));
    await sim.at(ts('2026-09-23 11:05'));
    await A.comment(actor('ahmed'), { revisionId: rev.revisionId }, `Pulling the sunrise pool shots from the ${dMon('2026-08-30')} pick-up day — first pass tomorrow.`);
    await sim.at(ts('2026-09-23 14:20'));
    await A.comment(actor('zainab'), { revisionId: rev.revisionId }, 'Key visual with the new logo position by Thursday. I’ll match Ahmed’s new opening frame.');
  });
}

function scheduleFalcon(): void {
  const F = 'falcon-2026-9-website';
  const spec: ProjectSpec = {
    key: F, client: 'falcon', y: 2026, m: 9,
    title: 'Corporate Website Rebuild', projectType: 'Website design & development',
    objective: 'Replace the 2014 WordPress site with a fast, bilingual corporate site that generates freight quotes and lets customers track shipments.',
    description: 'New design system, 18 page templates, headless CMS, shipment-tracking widget against the Falcon TMS API, quote and contact forms, and a full SEO migration.',
    requirements: 'Next.js front end on the client’s Azure tenant; CMS editors for marketing; WCAG 2.1 AA; Lighthouse ≥ 90 mobile; 301s for every indexed URL; EN + AR (RTL).',
    clientNotes: `Vikram approves design; Ahmed Saleh (IT) owns DNS and the staging server. Launch target ${dMonth('2026-10-15')}.`,
    internalNotes: 'PM QA on every deliverable — this is our biggest one-off of the quarter. Staging: staging.falconlogistics.example.',
    po: 'FL-PO-26-0931', price: 85000, requiresPmQa: true, priority: 'high',
    deadline: '2026-10-15', pm: 'fatima', triageAt: ts('2026-09-01 11:00'),
    poLines: ['Website design (4 deliverables)', 'Development (5 deliverables)', 'SEO migration (3 deliverables)'],
    brief: [
      ['Goals', 'Double monthly quote requests; cut "where is my shipment" calls to the ops desk by half.'],
      ['Audience', 'Procurement managers at retailers and manufacturers in the GCC.'],
      ['Scope', 'Home, 6 service pages, 5 industry pages, tracking, quote, about, careers, contact, news.'],
      ['Integrations', 'TMS REST API for tracking (read-only token); HubSpot for forms.'],
    ],
    kickoff: `Falcon kick-off: brief, PO and sitemap are attached. Design first (homepage by ${dMon('2026-09-07')}), SEO research in parallel, dev starts ${dMon('2026-09-08')}. PM QA on everything.`,
    teams: [
      {
        dept: 'design', planned: 4,
        assignments: [
          { who: 'sara', count: 2, base: 'Design', title: 'Homepage + inner page templates', instructions: 'Figma from the approved wireframes. Orange CTA, navy base.', kind: 'web', start: '2026-09-02', end: '2026-09-11', unitHours: 14,
            reference: asset('reference-moodboard.jpg', 'Falcon_Moodboard'),
            plans: [
              { upload: ts('2026-09-07 15:20'), completeAt: ts('2026-09-10 16:10') },
              { upload: ts('2026-09-10 12:00'), lead: ['changes_requested'], completeAt: ts('2026-09-16 15:40') },
            ] },
          { who: 'tom', count: 2, base: 'Design', title: 'Mobile layouts + icon set', instructions: 'Mobile breakpoints for every template; 24 line icons.', kind: (seq) => (seq === 3 ? 'mobile' : 'web'), start: '2026-09-03', end: '2026-09-14', unitHours: 10,
            plans: [
              { upload: ts('2026-09-11 11:30'), completeAt: ts('2026-09-16 15:45') },
              { upload: ts('2026-09-14 10:40'), stop: 'delivered' },
            ] },
        ],
      },
      {
        dept: 'development', planned: 5, planAt: ts('2026-09-08 10:00'),
        assignments: [
          { who: 'kevin', count: 3, base: 'Build', title: 'Homepage, services pages and CMS', instructions: 'Build from the approved Figma; components in Storybook; CMS schemas documented.', kind: (seq) => (seq === 3 ? 'release' : 'web'), start: '2026-09-08', end: '2026-09-30', priority: 'high', unitHours: 22,
            plans: [
              { upload: ts('2026-09-18 16:10'), lead: ['changes_requested'], stop: 'pm' },
              { upload: ts('2026-09-23 16:00'), stop: 'uploaded' },
              { upload: null },
            ] },
          { who: 'rohan', count: 2, base: 'Build', title: 'Tracking widget + quote/contact forms', instructions: 'Tracking against the TMS sandbox; forms to HubSpot with server-side validation.', kind: (seq) => (seq === 4 ? 'mobile' : 'release'), start: '2026-09-10', end: '2026-10-02', unitHours: 20,
            plans: [
              { upload: ts('2026-09-22 15:30'), lead: ['changes_requested'], stop: 'lead' },
              { upload: null },
            ] },
        ],
      },
      {
        dept: 'seo', planned: 3, planAt: ts('2026-09-02 09:30'),
        assignments: [
          { who: 'hannah', count: 2, base: 'SEO', title: 'Keyword research + metadata & schema', instructions: 'Research first (feeds the sitemap), then metadata for every template.', kind: (seq) => (seq === 1 ? 'keywords' : 'metadata'), start: '2026-09-02', end: '2026-09-25', unitHours: 9,
            plans: [
              { upload: ts('2026-09-04 14:30'), completeAt: ts('2026-09-10 11:00') },
              { upload: ts('2026-09-23 11:00'), stop: 'uploaded' },
            ] },
          { who: 'imran', count: 1, base: 'SEO', title: '301 redirect map', instructions: 'Map every indexed URL (crawl + Search Console) to its new home.', kind: 'redirects', start: '2026-09-14', end: '2026-09-29', unitHours: 8, plans: [{ upload: null }] },
        ],
      },
    ],
    comments: [
      { at: ts('2026-09-02 10:20'), who: 'sara', body: 'Homepage direction: navy hero with the container-stack illustration. Sharing a first frame on Thursday.' },
      { at: ts('2026-09-08 10:40'), who: 'arjun', body: 'Dev plan: Kevin on templates + CMS, Rohan on tracking and forms. We need the TMS sandbox token from Ahmed Saleh — Lina, can you chase?' },
      { at: ts('2026-09-08 11:15'), who: 'lina', body: 'Chased — token arrives tomorrow morning.' },
      { at: ts('2026-09-09 09:30'), who: 'rohan', body: 'Got the sandbox token, tracking endpoint responds. Rate limit is 5 req/s so I’ll debounce lookups.' },
      { at: ts('2026-09-21 12:30'), who: 'fatima', body: `Client review of the homepage build is booked for ${weekday('2026-09-24')} ${dMon('2026-09-24')}, 3pm. Kevin, please have the mobile fix in PM QA before then.` },
      { at: ts('2026-09-23 17:05'), who: 'kevin', body: 'Services pages are up on staging for lead QA. CMS setup is next.', slot: ['development', 2] },
    ],
  };
  sim.spawn(ts('2026-08-31 16:00'), 'file Falcon (won)', async () => {
    await fileSpec(spec, { opportunityId: reg.opps.get('falcon-website') });
    const rec = project(F);
    await A.attach(actor('lina'), { projectId: rec.id, purpose: 'reference' }, pdf('Falcon_Sitemap_v2', {
      title: 'Sitemap v2', subtitle: 'Falcon Logistics - corporate website', accent: [18, 44, 90],
      blocks: [
        { h: 'Top level' }, ...['Home', 'Services', 'Industries', 'Track shipment', 'Get a quote', 'About', 'Careers', 'News', 'Contact'].map((x) => ({ li: x })),
        { h: 'Services' }, ...['Sea freight', 'Air freight', 'Land freight', 'Warehousing', 'Customs clearance', 'Project cargo'].map((x) => ({ li: x })),
      ],
    }));
    await updateClient('lina', 'falcon', { startedOn: day('2026-09-01') });
    scheduleProject(spec);
  });
}

function scheduleOasisSeptember(): void {
  const seo = oasisSeo(2026, 9);
  seo.teams[0].assignments[0].plans = [{ upload: ts('2026-09-07 12:40'), completeAt: ts('2026-09-10 15:30') }];
  seo.teams[0].assignments[1].plans = [{ upload: null }];
  seo.teams[0].assignments[2].plans = [{ upload: ts('2026-09-16 14:10'), lead: ['changes_requested'], stop: 'lead' }];
  const social = oasisSocial(2026, 9);
  social.teams[0].assignments[0].plans = [{ upload: ts('2026-09-02 11:30'), completeAt: ts('2026-09-04 15:10') }];
  social.teams[0].assignments[1].plans = [{ upload: ts('2026-09-23 15:45'), stop: 'uploaded' }];
  social.teams[1].assignments[0].plans = [
    { upload: ts('2026-09-08 11:20'), deliverAt: ts('2026-09-16 11:30'), completeAt: ts('2026-09-18 12:00') },
    { upload: ts('2026-09-09 15:00'), lead: ['changes_requested'], deliverAt: ts('2026-09-16 11:35'), completeAt: ts('2026-09-18 12:05') },
    { upload: ts('2026-09-11 12:10'), stop: 'delivered', deliverAt: ts('2026-09-16 11:40') },
    { upload: ts('2026-09-15 10:30'), stop: 'delivered', deliverAt: ts('2026-09-16 11:45') },
  ];
  scheduleCopy(ts('2026-08-26 15:10'), 'oasis', [2026, 8], [seo, social], ['oasis-2026-8-seo', 'oasis-2026-8-social']);

  const walk: ProjectSpec = {
    key: 'oasis-2026-9-walkthrough', client: 'oasis', y: 2026, m: 9,
    title: 'Clinic Walkthrough Video', projectType: 'Video',
    objective: 'A calm, reassuring walkthrough of the refurbished Jumeirah clinic for the website and Google profile.',
    description: 'Half-day shoot; 60 s walkthrough plus a 20 s vertical cut.',
    requirements: 'No patients on camera without signed consent; 16:9 and 9:16 masters; soft instrumental track.',
    po: 'ODC-202609-VID', price: 12500, requiresPmQa: false, deadline: '2026-09-30', pm: 'fatima',
    triageAt: ts('2026-09-07 10:20'),
    teams: [{
      dept: 'video', planned: 2, planAt: ts('2026-09-08 11:00'),
      assignments: [{ who: 'bilal', count: 2, base: 'Video', title: 'Shoot + edit clinic walkthrough', instructions: 'Shoot at the Jumeirah clinic before opening hours; gimbal only.', kind: 'film', start: '2026-09-14', end: '2026-09-25', unitHours: 10, plans: [{ upload: null }, { upload: null }] }],
    }],
  };
  sim.spawn(ts('2026-09-04 12:30'), 'file Oasis walkthrough', async () => { await fileSpec(walk); scheduleProject(walk); });
  sim.spawn(ts('2026-09-10 16:05'), 'hold Oasis walkthrough', async () => {
    await A.status(actor('lina'), project(walk.key).id, 'hold', 'Jumeirah clinic is under renovation until mid-October — shoot postponed until the new reception is finished.');
    await A.comment(actor('lina'), { projectId: project(walk.key).id }, 'On hold at the client’s request. Dr. Leena will confirm a new shoot date once the contractors are out.');
  });
}

function scheduleDesertBloomSeptember(): void {
  const social = dbSocial(2026, 9);
  social.recurs = true;
  social.teams[0].assignments[0].plans = [{ upload: ts('2026-09-03 12:00'), stop: 'delivered', deliverAt: ts('2026-09-04 11:30') }];
  social.teams[0].assignments[1].plans = [{ upload: ts('2026-09-10 14:30'), lead: ['changes_requested'], stop: 'delivered', deliverAt: ts('2026-09-14 11:40') }];
  const designs = dbDesigns(2026, 9);
  designs.deadline = '2026-09-23';
  designs.teams[0].assignments[0].plans = ['2026-09-14 11:00', '2026-09-15 14:20', '2026-09-17 10:40', '2026-09-18 15:10', '2026-09-21 11:50', '2026-09-22 14:30']
    .map((t, i) => ({ upload: ts(t), lead: i === 3 ? ['changes_requested'] as QaDecision[] : [], stop: 'approved' as Stop }));
  const reels = dbReels(2026, 9);
  reels.teams[0].assignments[0].plans = [
    { upload: ts('2026-09-10 15:20'), stop: 'delivered', deliverAt: ts('2026-09-14 11:45') },
    { upload: ts('2026-09-18 12:10'), stop: 'delivered', deliverAt: ts('2026-09-22 11:30') },
    { upload: null },
  ];
  scheduleCopy(ts('2026-08-27 14:40'), 'desertbloom', [2026, 8], [social, designs, reels],
    ['desertbloom-2026-8-social', 'desertbloom-2026-8-designs', 'desertbloom-2026-8-reels']);

  sim.spawn(ts('2026-09-16 10:20'), 'Desert Bloom reel revision', async () => {
    const s = slot(reels.key, 'video', 1);
    const lina = actor('lina');
    const rev = await A.openRevision(lina, {
      projectId: project(reels.key).id, title: 'New cup sleeve in the closing shot', priority: 'normal', deadline: day('2026-09-24'),
      clientFeedback: 'Love it — can the closing shot use the new autumn cup sleeve, and add the Pistachio Rose price (AED 24)?',
      details: 'Sleeves arrive at Al Wasl on Monday; a pick-up shot is needed.', deliverableIds: [s.id],
    });
    await A.attach(lina, { projectId: project(reels.key).id, revisionId: rev.revisionId }, asset('post-cafe-square.jpg', 'Autumn_Cup_Sleeve_Reference'));
    await sim.at(ts('2026-09-16 12:15'));
    await A.handRevision(actor('hassan'), rev.revisionId, s.id, 'bilal', day('2026-09-24'));
    await A.comment(actor('bilal'), { revisionId: rev.revisionId }, 'Booked the pick-up shot at Al Wasl for Monday morning.');
    await sim.at(ts('2026-09-23 11:40'));
    await A.upload(actor('bilal'), s.id, fileFor('reel', { client: 'desertbloom', clientName: 'Desert Bloom Cafés', period: period(2026, 9), slotName: s.name, seq: s.seq, version: 2, dept: 'video' }), 'New closing shot with the autumn sleeve; price card added.');
  });

  const teaser: ProjectSpec = {
    key: 'desertbloom-2026-9-barista', client: 'desertbloom', y: 2026, m: 9,
    title: 'Barista Championship Teaser', projectType: 'Event promo',
    objective: `Promote the in-store barista championship final on ${dMonth('2026-09-13')}.`,
    description: 'One 20 s teaser and one event poster.',
    requirements: 'Teaser 9:16 with date and venue; poster A2 print + 1080×1350.',
    po: 'DB-2026-09-EV', price: 7800, requiresPmQa: false, deadline: '2026-09-11', pm: 'fatima', priority: 'high',
    triageAt: ts('2026-09-01 11:40'),
    teams: [
      { dept: 'video', planned: 1, assignments: [{ who: 'bilal', count: 1, base: 'Teaser', title: 'Championship teaser', instructions: 'Use last year’s final footage + new title cards.', kind: 'reel', start: '2026-09-02', end: '2026-09-08', priority: 'high', unitHours: 7,
        plans: [{ upload: ts('2026-09-07 14:10'), deliverAt: ts('2026-09-09 11:30'), completeAt: ts('2026-09-11 10:40') }] }] },
      { dept: 'design', planned: 1, assignments: [{ who: 'tom', count: 1, base: 'Poster', title: 'Event poster', instructions: 'A2 print-ready + social size.', kind: 'post', start: '2026-09-02', end: '2026-09-08', unitHours: 4,
        plans: [{ upload: ts('2026-09-08 10:20'), deliverAt: ts('2026-09-09 11:35'), completeAt: ts('2026-09-11 10:45') }] }] },
    ],
  };
  sim.spawn(ts('2026-09-01 10:50'), 'file Desert Bloom teaser', async () => { await fileSpec(teaser); scheduleProject(teaser); });
  // "Open next month" (brief §37) for the retainer.
  sim.spawn(ts('2026-09-23 17:20'), 'Desert Bloom opens October', async () => {
    const [ny, nm] = [period(2026, 10).year, period(2026, 10).month];
    await A.openMonth(actor('lina'), 'desertbloom', ny, nm);
  });
  sim.spawn(ts('2026-09-23 16:50'), 'Desert Bloom September draft invoice', async () => {
    await A.draftInvoice(actor('lina'), reg.months.get(monthKey('desertbloom', 2026, 9))!);
  });
}

function scheduleAlNoorSeptember(): void {
  const y = 2026;
  const m = 9;
  const videos = alNoorVideos(y, m, 10, ['ahmed', 'yusuf'], 'the Marina Heights Tower B launch');
  videos.teams[0].planned = 10;
  const [a1, a2] = videos.teams[0].assignments;
  Object.assign(a1, {
    count: 4, title: 'Edit reels 01–04: Tower B launch', start: '2026-09-02', end: '2026-09-16',
    plans: [
      { upload: ts('2026-09-07 11:20'), deliverAt: ts('2026-09-08 12:05'), completeBy: 'client', completeAt: ts('2026-09-09 10:40') },
      { upload: ts('2026-09-09 14:30'), lead: ['changes_requested'], stop: 'delivered', deliverAt: ts('2026-09-11 12:10') },
      { upload: ts('2026-09-14 16:00'), stop: 'delivered', deliverAt: ts('2026-09-16 11:45') },
      { upload: ts('2026-09-16 12:00'), lead: ['changes_requested'], deliverAt: ts('2026-09-21 11:30'), completeBy: 'client', completeAt: ts('2026-09-22 09:50') },
    ],
  } satisfies Partial<AssignmentSpec>);
  Object.assign(a2, {
    count: 4, title: 'Edit reels 05–08: amenities and lifestyle', start: '2026-09-07', end: '2026-09-22',
    plans: [
      { upload: ts('2026-09-10 12:30'), deliverAt: ts('2026-09-14 11:35'), completeAt: ts('2026-09-17 15:20') },
      { upload: ts('2026-09-15 11:10'), deliverAt: ts('2026-09-17 11:40'), completeBy: 'client', completeAt: ts('2026-09-18 10:05') },
      { upload: ts('2026-09-18 15:30'), lead: ['rejected'], stop: 'uploaded' },
      { upload: ts('2026-09-22 15:00'), stop: 'pm' },
    ],
  } satisfies Partial<AssignmentSpec>);
  // The brief's own example: Ahmed, 24–26 September, two deliverables, 0/2.
  videos.teams[0].assignments.push({
    who: 'ahmed', count: 2, base: 'Video', title: 'Client testimonial reels 09–10',
    instructions: 'Two resident testimonials from the Tower A handover interviews. 25–30 s each, EN/AR subtitles, same end card as the Tower B set.',
    kind: 'reel', start: '2026-09-24', end: '2026-09-26', priority: 'high', unitHours: 8,
    planAt: ts('2026-09-23 16:10'), plans: [{ upload: null }, { upload: null }],
  });
  videos.comments = [
    { at: ts('2026-09-01 11:10'), who: 'omar', body: `Mariam wants Tower B front-loaded: Videos 01–04 should all be with her by ${dMon('2026-09-16')}. Testimonials can come last.` },
    { at: ts('2026-09-01 14:05'), who: 'hassan', body: 'Split: Ahmed 01–04 (Tower B), Yusuf 05–08 (amenities). I’ll plan 09–10 once the testimonial interviews are transcribed.' },
    { at: ts('2026-09-02 09:40'), who: 'yusuf', body: 'Drone clips from the Tower B shoot are in /AlNoor/2026-09/Drone — Ahmed, the sunset pass is the one Mariam liked.' },
    { at: ts('2026-09-07 11:35'), who: 'ahmed', body: 'Video 01 is up. Used the sunset drone pass for the hook.' },
    { at: ts('2026-09-21 10:30'), who: 'yusuf', body: 'Re-exporting 07 at 9:16 — the preset reset after the update. Sorry!', slot: ['video', 7] },
    { at: ts('2026-09-22 10:10'), who: 'omar', body: 'Mariam asked for changes on Video 02 in the portal (subtitle size + price). Will open a revision once she confirms the new price list.' },
    { at: ts('2026-09-23 16:20'), who: 'hassan', body: 'Ahmed — testimonial reels 09–10 are yours from tomorrow; transcripts are in the brief folder.' },
  ];

  const designs = alNoorDesigns(y, m, 20, ['sara', 'zainab'], 'the Tower B launch');
  const [d1, d2] = designs.teams[0].assignments;
  const saraDays = ['2026-09-03 11:00', '2026-09-03 15:30', '2026-09-04 12:10', '2026-09-07 10:40', '2026-09-08 14:15', '2026-09-09 11:20', '2026-09-10 15:00', '2026-09-11 12:30', '2026-09-14 11:10', '2026-09-15 16:00'];
  const zainabDays = ['2026-09-07 12:00', '2026-09-08 11:30', '2026-09-09 15:40', '2026-09-10 11:15', '2026-09-14 14:20', '2026-09-15 11:45', '2026-09-16 15:30', '2026-09-17 12:00', '2026-09-23 14:10', '2026-09-23 16:30'];
  Object.assign(d1, {
    count: 10, title: 'Feed posts 01–10: Tower B launch', start: '2026-09-02', end: '2026-09-18',
    plans: saraDays.map((t, i): SlotPlan => ({
      upload: ts(t), lead: i === 4 ? ['changes_requested'] : [],
      completeBy: i % 2 === 0 ? 'client' : 'sales',
    })),
  } satisfies Partial<AssignmentSpec>);
  Object.assign(d2, {
    count: 10, title: 'Stories and carousels 11–20', start: '2026-09-03', end: '2026-09-23',
    plans: zainabDays.map((t, i): SlotPlan => (i >= 8
      ? { upload: ts(t), stop: 'uploaded' }
      : i >= 6 ? { upload: ts(t), stop: 'approved' }
        : i >= 2 ? { upload: ts(t), stop: 'delivered', lead: i === 3 ? ['changes_requested'] : [] }
          : { upload: ts(t), completeBy: 'sales' })),
  } satisfies Partial<AssignmentSpec>);

  const seo = alNoorSeo(y, m);
  seo.teams[0].assignments[0].plans = [{ upload: ts('2026-09-04 12:30'), completeAt: ts('2026-09-10 11:00') }];
  seo.teams[0].assignments[1].plans = [{ upload: ts('2026-09-23 14:00'), stop: 'uploaded' }];
  seo.teams[0].assignments[2].plans = [{ upload: ts('2026-09-15 16:20'), lead: ['changes_requested'], stop: 'delivered' }];
  seo.teams[0].assignments.push({ who: 'hannah', count: 1, base: 'Blog Article', title: 'Second article: Tower B investor guide', instructions: 'Investor angle: yields, service charges, handover. 1,200+ words.', kind: 'blog', start: '2026-09-16', end: '2026-09-29', unitHours: 7, plans: [{ upload: null }] });
  seo.teams[0].planned = 4;
  const social = alNoorSocial(y, m);
  social.teams[0].assignments[0].plans = [{ upload: ts('2026-09-02 12:20'), completeAt: ts('2026-09-04 16:00') }];
  social.teams[0].assignments[1].plans = [{ upload: null }];

  scheduleCopy(wd(2026, 8, -4, '11:20'), 'alnoor', [2026, 8], [videos, designs, seo, social],
    ['alnoor-2026-8-videos', 'alnoor-2026-8-designs', 'alnoor-2026-8-seo', 'alnoor-2026-8-social']);

  // The client's decisions in the portal on the September videos.
  sim.spawn(ts('2026-09-22 09:15'), 'Al Noor asks for changes on Video 02', async () => {
    const s = slot(videos.key, 'video', 2);
    await A.clientDecision(portalActor('alnoor'), deliveryOf(s.id), 'changes_requested',
      'The Arabic subtitles are hard to read on mobile — please make them larger, and show the starting price as “from AED 1.35M”.');
  });

  // A design revision Sales opened this morning, not yet handed out.
  sim.spawn(ts('2026-09-24 10:05'), 'Al Noor design revision', async () => {
    const omar = actor('omar');
    const s3 = slot(designs.key, 'design', 3);
    const s5 = slot(designs.key, 'design', 5);
    const rev = await A.openRevision(omar, {
      projectId: project(designs.key).id, title: 'Swap hero image on carousel posts', priority: 'normal', deadline: day('2026-09-29'),
      clientFeedback: 'For posts 03 and 05 please use the pool view from the new Tower B shoot instead of the lobby.',
      details: 'Mariam sent the selected frames on WhatsApp; they are attached here.', deliverableIds: [s3.id, s5.id],
    });
    await A.attach(omar, { projectId: project(designs.key).id, revisionId: rev.revisionId }, asset('post-realestate-square.jpg', 'TowerB_PoolView_Selected'));
  });

  // Dubai Hills landing pages: filed, routed, planned for next week.
  const web: ProjectSpec = {
    ...alNoorWebsite(y, m, 'Website Update — Dubai Hills Launch Pages', 3, 2, 16500),
    triageAt: ts('2026-09-16 10:00'), deadline: '2026-10-09',
  };
  web.teams[0].planAt = ts('2026-09-17 11:30');
  web.teams[0].assignments[0] = { ...web.teams[0].assignments[0], start: '2026-09-28', end: '2026-10-02', plans: [{ upload: null }, { upload: null }] };
  web.teams[1].planAt = ts('2026-09-22 12:00');
  web.teams[1].assignments = [{ who: 'kevin', count: 3, base: 'Build', title: 'Build Dubai Hills landing pages', instructions: 'Build on staging from the approved designs; RTL variant; CRM form.', kind: 'web', start: '2026-10-01', end: '2026-10-08', unitHours: 14, plans: [{ upload: null }, { upload: null }, { upload: null }] }];
  sim.spawn(ts('2026-09-15 12:30'), 'file Al Noor Dubai Hills pages', async () => { await fileSpec(web); scheduleProject(web); });

  // October: Omar copies September forward (brief §38); the orders land in the PM's intake.
  sim.spawn(ts('2026-09-22 16:30'), 'Al Noor copy to October', async () => {
    const omar = actor('omar');
    const oct = period(2026, 10);
    const src = (k: string) => project(k).id;
    const lastWd = day(wdDate(2026, 10, -2));
    const r = await A.copyMonth(omar, {
      clientId: reg.clients.get('alnoor')!, fromMonthId: reg.months.get(monthKey('alnoor', 2026, 9))!, period: oct.value,
      projects: [
        { sourceProjectId: src(videos.key), title: `Social Media Videos — ${oct.label}`, departments: [{ departmentId: DEPT.video, plannedDeliverables: 10 }], deadline: lastWd, priceAmount: '34000.00' },
        { sourceProjectId: src(designs.key), title: `Social Media Designs — ${oct.label}`, departments: [{ departmentId: DEPT.design, plannedDeliverables: 18 }], deadline: lastWd, priceAmount: '21600.00' },
        { sourceProjectId: src(seo.key), title: `SEO Monthly Retainer — ${oct.label}`, departments: [{ departmentId: DEPT.seo, plannedDeliverables: 4 }], deadline: day(wdDate(2026, 10, -1)), priceAmount: '8500.00' },
        { sourceProjectId: src(social.key), title: `Community Management & Content Calendar — ${oct.label}`, departments: [{ departmentId: DEPT.social, plannedDeliverables: 2 }], deadline: day(wdDate(2026, 10, -1)), priceAmount: '6500.00' },
      ],
    });
    for (const [i, key] of ['videos', 'designs', 'seo', 'social'].entries()) {
      reg.projects.set(`alnoor-2026-10-${key}`, {
        key: `alnoor-2026-10-${key}`, id: r.projects[i].projectId, code: r.projects[i].projectCode, client: 'alnoor',
        sales: 'omar', pm: 'daniel', requiresPmQa: key === 'videos', y: 2026, m: 10,
      });
    }
    reg.months.set(monthKey('alnoor', 2026, 10), r.clientMonthId);
  });
  sim.spawn(ts('2026-09-23 17:00'), 'Al Noor September draft invoice', async () => {
    await A.draftInvoice(actor('omar'), reg.months.get(monthKey('alnoor', 2026, 9))!);
  });
}

function scheduleSummitAndMarina(): void {
  const coach: ProjectSpec = {
    key: 'summit-2026-9-coach', client: 'summit', y: 2026, m: 9,
    title: 'Coach Profile Series', projectType: 'Social media videos',
    objective: 'Introduce the academy’s five head coaches to parents before the new season.',
    description: 'Five 45 s coach profiles (interview + training footage) with a matching thumbnail each.',
    requirements: '9:16 and 1:1 exports; parental consent on file for every child in shot; EN subtitles.',
    clientNotes: 'Shoot days are Saturdays only (training sessions).',
    internalNotes: 'Design capacity to confirm — Maya to pick this up after the Dubai Hills pages.',
    po: 'SSA-PO-0017', price: 27500, requiresPmQa: true, deadline: '2026-10-16', pm: 'daniel',
    triageAt: ts('2026-09-22 10:30'),
    teams: [
      { dept: 'video', planned: 5, lead: 'hassan', planAt: ts('2026-09-30 09:00'), assignments: [] },
      { dept: 'design', planned: 5, lead: null, assignments: [] },
    ],
  };
  sim.spawn(ts('2026-09-17 11:00'), 'file Summit coaches (won)', async () => {
    await fileSpec(coach, { opportunityId: reg.opps.get('summit-coach') });
    await updateClient('omar', 'summit', { startedOn: day('2026-09-17') });
    scheduleProject(coach);
  });
  const launch: ProjectSpec = {
    key: 'summit-2026-9-launch', client: 'summit', y: 2026, m: 9,
    title: 'Season Launch Campaign', projectType: 'Integrated campaign',
    objective: 'Fill the autumn term: 400 trial-session sign-ups across football, swimming and tennis.',
    description: 'Four launch videos, six social designs and a four-week paid social plan.',
    requirements: 'Videos 9:16 and 16:9; designs 1080×1350 and stories; sign-up link in every asset; parental consent on file for every child in shot.',
    clientNotes: `Launch date ${dMonth('2026-10-05')}. Hiba approves all copy.`,
    po: 'SSA-PO-0021', price: 42000, requiresPmQa: true, deadline: '2026-10-23', pm: 'daniel', triageAt: null,
    teams: [{ dept: 'video', planned: 4, assignments: [] }, { dept: 'design', planned: 6, assignments: [] }, { dept: 'social', planned: 1, assignments: [] }],
    brief: [
      ['Goal', `400 trial sign-ups before ${dMonth('2026-10-31')}.`],
      ['Audience', 'Parents of 6-14 year olds in Al Quoz, Al Barsha and Dubai Sports City.'],
      ['Message', 'Real coaches, real progress: every child gets a skills report after the trial.'],
    ],
  };
  sim.spawn(ts('2026-09-24 09:40'), 'file Summit launch', async () => { await fileSpec(launch); });

  const mm: ProjectSpec = {
    key: 'marina-2026-9-showroom', client: 'marina', y: 2026, m: 9,
    title: 'Q4 Showroom Launch Video', projectType: 'Launch video',
    objective: 'Launch the new EV line at the Sheikh Zayed Road showroom.',
    description: 'Night shoot in the showroom; 45 s launch film, 15 s cutdown; two key visuals.',
    requirements: '16:9 and 9:16; brand colours per the OEM guidelines; OEM approval before publication.',
    po: 'MM-4410-26', price: 36000, requiresPmQa: true, deadline: '2026-09-30', pm: 'daniel', triageAt: ts('2026-09-04 09:30'),
    teams: [
      { dept: 'video', planned: 2, assignments: [{ who: 'yusuf', count: 2, base: 'Video', title: 'Launch film + cutdown', instructions: 'Night shoot on the 11th; OEM logo rules apply.', kind: 'film', start: '2026-09-07', end: '2026-09-18', unitHours: 14,
        plans: [{ upload: ts('2026-09-14 16:40'), stop: 'uploaded' }, { upload: null }] }] },
      { dept: 'design', planned: 2, assignments: [{ who: 'tom', count: 2, base: 'Key Visual', title: 'Launch key visuals', instructions: 'Two key visuals from the OEM image bank.', kind: 'post', start: '2026-09-07', end: '2026-09-14', unitHours: 5,
        plans: [{ upload: ts('2026-09-09 12:20'), stop: 'approved' }, { upload: ts('2026-09-11 15:10'), stop: 'uploaded' }] }] },
    ],
  };
  sim.spawn(ts('2026-09-03 10:00'), 'file Marina (won)', async () => {
    await fileSpec(mm, { opportunityId: reg.opps.get('marina-launch') });
    await updateClient('omar', 'marina', { startedOn: day('2026-09-03') });
    scheduleProject(mm);
  });
  sim.spawn(ts('2026-09-15 11:20'), 'cancel Marina', async () => {
    const omar = actor('omar');
    await A.status(omar, project(mm.key).id, 'cancel', 'Budget withdrawn — the client’s regional office froze all Q4 marketing spend. Approved key visual 01 is still to be handed over.');
    await A.comment(omar, { projectId: project(mm.key).id }, 'Tariq called this morning: budget withdrawn. Thanks all — Key Visual 01 goes to the client for their records.');
  });
  sim.spawn(ts('2026-09-16 11:00'), 'Marina hand-over', async () => {
    const omar = actor('omar');
    await A.delivery(omar, deliveryOf(slot(mm.key, 'design', 1).id), 'delivered', { notes: 'Sent the approved key visual for the client’s records' });
    await updateClient('omar', 'marina', { status: 'paused' });
  });
}

/** The agency's own work: the CEO books it, the COO runs it. */
function scheduleInternal(): void {
  const reel: ProjectSpec = {
    key: 'aktivacity-2026-9-showreel', client: 'aktivacity', y: 2026, m: 9,
    title: 'Agency Showreel 2026', projectType: 'Internal',
    objective: 'A 90-second showreel of the year’s best work for the website, pitches and the Cityscape stand.',
    description: 'Highlights from Gulf Horizon, Al Noor and Desert Bloom (portfolio use approved by each client), plus case-study thumbnails for the website.',
    requirements: '16:9 master and a 9:16 cut; only work the clients approved for portfolio use; music from the agency’s Artlist licence.',
    internalNotes: 'Internal and not billable. Priya is PM on this one; fit it around client work.',
    po: 'INTERNAL', price: null, requiresPmQa: false, priority: 'low',
    deadline: '2026-10-09', pm: 'coo', triageAt: ts('2026-09-08 11:00'), attachPo: false,
    kickoff: 'Showreel: Yusuf edits around the Al Noor reels, Zainab does the case-study thumbnails. Target is the Cityscape stand in October.',
    teams: [
      {
        dept: 'video', planned: 2,
        assignments: [{ who: 'yusuf', count: 2, base: 'Showreel', title: 'Showreel master + vertical cut', instructions: 'Open on the Gulf Horizon brand film; 90 s master, then a 30 s 9:16 cut.', kind: 'film', start: '2026-09-09', end: '2026-09-30', priority: 'low', unitHours: 14,
          plans: [{ upload: ts('2026-09-21 16:10'), lead: ['changes_requested'], stop: 'uploaded' }, { upload: null }] }],
      },
      {
        dept: 'design', planned: 2,
        assignments: [{ who: 'zainab', count: 2, base: 'Case Study', title: 'Case-study thumbnails', instructions: 'One per featured client, 1600×900, agency template.', kind: 'thumb', start: '2026-09-14', end: '2026-09-25', priority: 'low', unitHours: 3,
          plans: [{ upload: ts('2026-09-16 15:20'), stop: 'approved' }, { upload: ts('2026-09-22 12:40'), stop: 'uploaded' }] }],
      },
    ],
    comments: [
      { at: ts('2026-09-08 12:15'), who: 'ceo', body: 'Lead with the Gulf Horizon brand film — it is the best thing we made this year. Keep it under 90 seconds.' },
      { at: ts('2026-09-22 10:05'), who: 'hassan', body: 'Yusuf, the pacing in the middle section drags — tighten the Desert Bloom montage and it’s there.', slot: ['video', 1] },
    ],
  };
  sim.spawn(ts('2026-09-08 10:40'), 'file showreel', async () => { await fileSpec(reel); scheduleProject(reel); });
}

function schedulePortal(): void {
  sim.spawn(ts('2026-06-01 10:00'), 'Al Noor portal login', async () => {
    const omar = actor('omar');
    const clientId = reg.clients.get('alnoor')!;
    const r = await createPortalLogin(omar, { clientId, fullName: 'Mariam Al Suwaidi', email: 'marketing@alnoor-realestate.example' });
    await recordActivity({ actorId: omar.id, action: 'portal.login_created', entityType: 'user', entityId: r.userId, clientId });
    ID.alnoorPortal = r.userId;
    portalLogins.set('alnoor', 'alnoorPortal');
    await loadActor('alnoorPortal');
    await sim.at(ts('2026-06-01 15:30'));
    // Mariam signs in with the one-time password and chooses her own (the demo password).
    await sql`UPDATE users SET password_hash = ${await hashPassword(PASSWORD)}, must_change_password = false WHERE id = ${r.userId}`;
    await recordActivity({ actorId: r.userId, action: 'user.password_changed', entityType: 'user', entityId: r.userId });
    await loadActor('alnoorPortal');
  });
}

/* ================================================================ time == */

/** Each executive's day: 4–8.5 hours split over whatever they were working on. */
async function timeSheets(): Promise<{ logged: number; direct: number }> {
  const byUser = new Map<string, WorkWindow[]>();
  for (const w of reg.work) byUser.set(w.user, [...(byUser.get(w.user) ?? []), w]);
  // Time sheets are filled in up to yesterday (today's are still open), so the
  // data depends on the date the seed runs, not the hour.
  const today = addDays(REAL_TODAY, -1);
  const cutoff = addDays(REAL_TODAY, -21);
  const users = [...byUser.keys()].sort();
  let logged = 0;
  let direct = 0;
  const bulk: { a: number; p: number; u: number; d: string; min: number; note: string; at: string }[] = [];

  const [{ current_date: dbToday }] = await sql<{ current_date: string }[]>`SELECT current_date::text AS current_date`;
  for (const user of users) {
    const windows = byUser.get(user)!;
    const first = windows.reduce((a, w) => (w.start < a ? w.start : a), windows[0].start);
    for (let d = first; d <= today; d = addDays(d, 1)) {
      if (weekend(d)) continue;
      const live = windows.filter((w) => w.start <= d && d <= (w.closedOn ?? w.end));
      if (live.length === 0) continue;
      if (chance(0.04)) continue; // a day off, a training day
      const total = int(16, 34) * 15; // 4h–8h30 in quarter hours
      const weights = live.map((w) => w.weight);
      const sum = weights.reduce((a, b) => a + b, 0);
      let left = total;
      live.forEach((w, i) => {
        const share = i === live.length - 1 ? left : Math.max(30, Math.round((total * weights[i]) / sum / 15) * 15);
        const minutes = Math.min(share, left);
        left -= minutes;
        if (minutes <= 0) return;
        const note = pick(TIME_NOTES[w.dept]);
        const at = atLocal(d, hm(int(17 * 60 + 20, 18 * 60 + 40)));
        bulk.push({ a: w.assignmentId, p: w.projectId, u: ID[user], d, min: minutes, note, at: at.toISOString() });
      });
    }
  }

  for (const e of bulk) {
    const recent = e.d >= cutoff && e.d <= dbToday;
    if (recent) {
      const [state] = await sql<{ month_status: string; status: string }[]>`
        SELECT cm.status AS month_status, p.status FROM projects p JOIN client_months cm ON cm.id = p.client_month_id WHERE p.id = ${e.p}`;
      if (state.month_status === 'open' && state.status !== 'cancelled') {
        const who = [...actors.values()].find((a) => a.id === e.u)!;
        await clock.stamp(new Date(Math.min(Date.parse(e.at), LATEST)), async () => {
          const r = await logTime(who, { assignmentId: e.a, workDate: e.d, minutes: e.min, note: e.note });
          await recordActivity({ actorId: who.id, action: 'time.logged', entityType: 'time_entry', entityId: r.entryId, metadata: { assignmentId: e.a, minutes: e.min, workDate: e.d } });
        });
        logged++;
        continue;
      }
    }
    // Older than the portal lets anyone back-date (31 days), or in a month
    // since closed: written as the time sheet would have recorded it then.
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO time_entries (assignment_id, project_id, user_id, work_date, minutes, note, created_at)
      VALUES (${e.a}, ${e.p}, ${e.u}, ${e.d}, ${e.min}, ${e.note}, ${e.at}) RETURNING id`;
    await sql`
      INSERT INTO activity_log (actor_id, action, entity_type, entity_id, metadata, created_at)
      VALUES (${e.u}, 'time.logged', 'time_entry', ${Number(row.id)},
              ${JSON.stringify({ assignmentId: e.a, minutes: e.min, workDate: e.d })}::jsonb, ${e.at})`;
    direct++;
  }
  return { logged, direct };
}

/* ============================================================ finishing == */

async function finish(): Promise<void> {
  const now = new Date(REAL_NOW).toISOString();
  // A realistic inbox: what arrived before the last five days has been read,
  // and so has everything beyond each person's dozen newest. The boundary is
  // a midnight, so the result does not depend on the hour the seed runs.
  const boundary = atLocal(addDays(REAL_TODAY, -5), '00:00').toISOString();
  await sql`
    UPDATE notifications n SET is_read = true,
           read_at = LEAST(n.created_at + ((n.id * 37) % 480 + 12) * interval '1 minute', ${now}::timestamptz - interval '1 hour')
    WHERE n.created_at < ${boundary}::timestamptz
       OR n.id NOT IN (SELECT id FROM (
            SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
            FROM notifications) ranked WHERE rn <= 12)`;
  // Everyone active has signed in recently.
  await sql`
    UPDATE users SET last_login_at = ${now}::timestamptz - ((id * 53) % 2600 + 45) * interval '1 minute'
    WHERE is_active`;
  await sql`
    UPDATE users SET last_login_at = deactivated_at - interval '2 hours 10 minutes' WHERE NOT is_active`;
  const lu = await sql<{ id: string; u: string }[]>`SELECT id::text AS id, updated_at::text AS u FROM users`;
  const users = clock.updatedAt.get('users') ?? new Map<string, string>();
  for (const r of lu) if (!users.has(r.id)) users.set(r.id, r.u);
  clock.updatedAt.set('users', users);
  await clock.settle();
}

/* ================================================================ reset == */

async function prepare(): Promise<void> {
  const [{ exists }] = await sql<{ exists: boolean }[]>`SELECT to_regclass('public.users') IS NOT NULL AS exists`;
  if (!exists) throw new SeedRefusal('The database has no schema yet. Apply the migrations first (npm run db:migrate).');
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
  if (n > 0 && !RESET) {
    throw new SeedRefusal([
      `This database already has ${n} user(s); the demo seed only fills an empty portal.`,
      'To wipe it (every table and the uploaded files) and load the demo instead, run it again with --reset:',
      '  node --conditions=react-server --import tsx scripts/seed-demo.ts --reset',
    ].join('\n'));
  }
  if (RESET) {
    if (process.env.NODE_ENV === 'production') {
      throw new SeedRefusal('Refusing --reset with NODE_ENV=production: the demo seed is for local machines only.');
    }
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT IN ('_migrations', 'departments')`;
    await sql.unsafe(`TRUNCATE ${tables.map((t) => `"${t.table_name}"`).join(', ')} RESTART IDENTITY CASCADE`);
    // billing_settings is a one-row table the migration creates.
    await sql`INSERT INTO billing_settings (id) VALUES (1) ON CONFLICT DO NOTHING`;
    const root = path.resolve(process.env.STORAGE_ROOT!);
    await rm(path.join(root, 'files'), { recursive: true, force: true });
    await rm(path.join(root, 'tmp'), { recursive: true, force: true });
    console.log(`Reset: emptied ${tables.length} tables and ${root}/{files,tmp}.`);
  } else {
    const root = path.resolve(process.env.STORAGE_ROOT!);
    if (existsSync(path.join(root, 'files')) && (await readdir(path.join(root, 'files'))).length > 0) {
      console.warn(`Note: ${root}/files already has content; it is left alone.`);
    }
  }
}

/* ============================================================== summary == */

async function summary(seconds: number, times: { logged: number; direct: number }): Promise<void> {
  const counts = await sql<{ table_name: string; n: number }[]>`
    SELECT table_name, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', table_name), false, true, '')))[1]::text::int AS n
    FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_migrations'
    ORDER BY table_name`;
  const current = period(2026, 9);
  const statuses = await sql<{ status: string; n: number; now: number }[]>`
    SELECT s.status::text AS status,
           count(p.id)::int AS n,
           count(p.id) FILTER (WHERE cm.period_year = ${current.year} AND cm.period_month = ${current.month})::int AS now
    FROM unnest(enum_range(NULL::project_status)) AS s(status)
    LEFT JOIN projects p ON p.status = s.status
    LEFT JOIN client_months cm ON cm.id = p.client_month_id
    GROUP BY s.status ORDER BY array_position(enum_range(NULL::project_status), s.status)`;
  const months = await sql<{ name: string; months: string }[]>`
    SELECT c.name, string_agg(cm.period_year || '-' || lpad(cm.period_month::text, 2, '0') || CASE WHEN cm.status = 'closed' THEN '✓' ELSE '' END, ' ' ORDER BY cm.period_year, cm.period_month) AS months
    FROM clients c JOIN client_months cm ON cm.client_id = c.id GROUP BY c.name ORDER BY c.name`;

  console.log(`\nDemo data loaded in ${seconds.toFixed(0)} s (${sim.steps} simulated steps; ${times.logged} time entries through the time sheet, ${times.direct} back-dated).`);
  if (SHIFT_DAYS !== 0) console.log(`The story (written for ${BASE_TODAY}) was moved ${SHIFT_DAYS} day(s) / ${SHIFT_MONTHS} month(s) to today.`);
  console.log('\nRows per table');
  for (const c of counts) console.log(`  ${c.table_name.padEnd(26)} ${String(c.n).padStart(6)}`);
  console.log(`\nProjects by status (all months / ${current.label})`);
  for (const s of statuses) console.log(`  ${s.status.padEnd(22)} ${String(s.n).padStart(4)} ${String(s.now).padStart(4)}${s.n === 0 ? '   (never set by the domain layer)' : ''}`);
  console.log('\nClient months (✓ = closed)');
  for (const m of months) console.log(`  ${m.name.padEnd(30)} ${m.months}`);

  const logins = await sql<{ email: string; role: string; full_name: string; team: string | null; is_active: boolean }[]>`
    SELECT u.email, u.role::text AS role, u.full_name, u.is_active,
           string_agg(d.name || CASE WHEN dm.is_lead THEN ' (lead)' ELSE '' END, ', ') AS team
    FROM users u LEFT JOIN department_members dm ON dm.user_id = u.id LEFT JOIN departments d ON d.id = dm.department_id
    GROUP BY u.id ORDER BY array_position(ARRAY['admin','ceo','coo','sales','project_manager','team_lead','executive','client']::text[], u.role::text), u.id`;
  console.log(`\nLogins — every account uses the password ${PASSWORD}`);
  for (const l of logins) {
    const note = l.is_active ? '' : '  (deactivated — cannot sign in)';
    console.log(`  ${l.email.padEnd(40)} ${l.role.padEnd(16)} ${l.full_name.padEnd(20)} ${(l.team ?? (l.role === 'client' ? 'Al Noor Real Estate (portal)' : '')).padEnd(24)}${note}`);
  }
  if (sim.late.length > 0) {
    console.log(`\n${sim.late.length} step(s) were scheduled in the past and ran late:`);
    for (const l of sim.late.slice(0, 10)) console.log(`  ${l}`);
  }
}

/* ================================================================= main == */

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new SeedRefusal('DATABASE_URL is not set.');
  if (!process.env.STORAGE_ROOT) {
    throw new SeedRefusal('STORAGE_ROOT is not set. Use the same directory the portal serves files from, or the demo files will be missing.');
  }
  const started = Date.now();
  sql = getSql();

  // The domain layer reports some failures by logging rather than throwing
  // (activity and notification writes must never break the work). For the
  // seed, any such failure is a bug to fix, so it stops the run.
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const first = String(args[0] ?? '');
    if (first.startsWith('[audit]') || first.startsWith('[notify]')) logged.push(args.map(String).join(' '));
    original(...args);
  };

  await prepare();
  await loadAssets();
  clock = new Clock();
  await clock.init();
  sim = new Sim(clock);

  await scheduleCompany();
  schedulePipeline();
  schedulePortal();
  scheduleAlNoor();
  scheduleOasis();
  scheduleDesertBloom();
  scheduleGulf();
  scheduleFalcon();
  scheduleOasisSeptember();
  scheduleDesertBloomSeptember();
  scheduleAlNoorSeptember();
  scheduleSummitAndMarina();
  scheduleInternal();

  let lastMonth = '';
  await sim.run((t) => {
    const month = dubaiDate(t).slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      process.stdout.write(`  simulating ${month} …\n`);
    }
    if (logged.length > 0) throw new Error(`The domain layer logged a failure: ${logged[0]}`);
  });
  const times = await timeSheets();
  await finish();
  if (logged.length > 0) throw new Error(`The domain layer logged a failure: ${logged[0]}`);
  await summary((Date.now() - started) / 1000, times);
}

main()
  .catch((error) => {
    if (error instanceof SeedRefusal) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error('\nDemo seed failed:', error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql?.end({ timeout: 5 });
  });
