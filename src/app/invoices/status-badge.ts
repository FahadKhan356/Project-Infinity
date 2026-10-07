import type { InvoiceStatus } from '@/lib/invoices/invoices';

export function statusBadge(status: InvoiceStatus, overdue = false): { label: string; className: string } {
  if (overdue) return { label: 'Overdue', className: 'bg-red-500/10 text-red-600 dark:text-red-400' };
  switch (status) {
    case 'draft': return { label: 'Draft', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' };
    case 'issued': return { label: 'Unpaid', className: 'bg-accent/10 text-accent' };
    case 'paid': return { label: 'Paid', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' };
    default: return { label: 'Void', className: 'bg-border text-muted line-through' };
  }
}
