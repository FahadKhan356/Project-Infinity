import type { ClientReport, PortfolioReport } from './monthly';

/**
 * CSV for the monthly reports. Pure — no database, no actor — so the
 * escaping can be tested on its own. Pricing columns are present only when
 * the report was loaded with pricing, which loadPortfolioReport() and
 * loadClientReport() decide from can(actor, 'pricing.view').
 */
export type CsvValue = string | number | null | undefined;

/**
 * One RFC 4180 field. Text that a spreadsheet would read as a formula
 * (leading =, +, -, @, tab or carriage return) is prefixed with an
 * apostrophe first — a client or project name typed as `=HYPERLINK(...)`
 * must arrive in Excel as text. Numbers are ours, not user input, and are
 * written as they are so negative values still sum.
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Rows to a CSV document: CRLF line ends, and a BOM so Excel reads UTF-8 names correctly. */
export function toCsv(rows: CsvValue[][]): string {
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function portfolioCsv(report: PortfolioReport): string {
  const pricing = report.showPricing;
  const header = [
    'Client', 'Projects', 'Deliverables', 'Completed', 'Ready to deliver', 'In QA', 'In revision', 'Pending',
    'Departments', ...(pricing ? ['Order value', 'Currency'] : []),
  ];
  const line = (name: string, r: PortfolioReport['totals']): CsvValue[] => [
    name, r.projects, r.deliverables, r.completed, r.ready, r.inQa, r.inRevision, r.pending,
    r.departments.join(', '),
    ...(pricing ? [r.value?.amount ?? '', r.value?.currency ?? ''] : []),
  ];
  return toCsv([
    header,
    ...report.rows.map((r) => line(r.clientName, r)),
    line('Total', report.totals),
  ]);
}

export function clientCsv(report: ClientReport): string {
  const pricing = report.showPricing;
  const header = [
    'Project code', 'Title', 'Status', 'Teams', 'Approved', 'Deliverables', 'Deadline', 'Delivered',
    ...(pricing ? ['Order value', 'Currency'] : []),
  ];
  return toCsv([
    header,
    ...report.projects.map((p): CsvValue[] => [
      p.projectCode, p.title, p.status, p.teams, p.approved, p.total, p.deadline, p.deliveredOn,
      ...(pricing ? [p.value?.amount ?? '', p.value?.currency ?? ''] : []),
    ]),
  ]);
}

/** Something safe to put in a Content-Disposition filename. */
export function csvFilename(parts: string[]): string {
  const slug = parts
    .map((p) => p.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase())
    .filter(Boolean)
    .join('-');
  return `${slug || 'report'}.csv`;
}
