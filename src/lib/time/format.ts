/** Duration helpers shared by the planning form, time tracking and reports. Pure. */

/** "2h 30m", "45m", "6h". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * "6", "1.5" or "2:30" hours to minutes; blank to null. Throws RangeError on
 * anything else, or on more than `maxHours`.
 */
export function parseHours(value: string | null, maxHours = 10000): number | null {
  if (value === null || value.trim() === '') return null;
  const clock = /^(\d{1,5}):([0-5]\d)$/.exec(value.trim());
  const minutes = clock
    ? Number(clock[1]) * 60 + Number(clock[2])
    : Math.round(Number(value) * 60);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > maxHours * 60) {
    throw new RangeError('Enter hours like 6, 1.5 or 2:30.');
  }
  return minutes;
}
