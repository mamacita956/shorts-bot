export function parseTime(hhmm: string): { h: number; m: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { h, m };
}

function atTime(day: Date, hhmm: string): Date {
  const { h, m } = parseTime(hhmm);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

/**
 * The next publish time: `intervalDays` after the last booked slot, at the configured local time,
 * but never sooner than `minLeadMinutes` from now (after a gap the channel restarts at the next free time).
 */
export function nextSlot(opts: { now: Date; lastSlot?: Date; intervalDays: number; time: string; minLeadMinutes?: number }): Date {
  const earliest = new Date(opts.now.getTime() + (opts.minLeadMinutes ?? 30) * 60_000);
  let soonest = atTime(earliest, opts.time);
  if (soonest < earliest) soonest = atTime(addDays(earliest, 1), opts.time);
  if (!opts.lastSlot) return soonest;
  const afterLast = atTime(addDays(opts.lastSlot, opts.intervalDays), opts.time);
  return afterLast > soonest ? afterLast : soonest;
}
