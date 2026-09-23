/** Presentation helpers shared by server and client components — no DB, no secrets. */

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** `awaiting_lead_qa` → `awaiting lead QA`, for display only. */
export function statusLabel(status: string): string {
  return status.replace(/_/g, ' ').replace(/\bqa\b/gi, 'QA').replace(/\bpm\b/gi, 'PM');
}
