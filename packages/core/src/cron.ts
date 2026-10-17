/**
 * Five-field cron (minute hour day-of-month month day-of-week), evaluated in UTC.
 * shortcut: no names (JAN, MON), no `?` `L` `W` `#`, no seconds, no time zones; add them when a
 * schedule needs one. As in Vixie cron, a day field that starts with a star (a star alone, a star
 * with a step, a star in a list) makes day-of-month and day-of-week AND together; with both
 * restricted either one matches. A step needs a star or a range: a bare `5/10` is refused.
 */
const FIELDS = {
  minute: { name: "minute", min: 0, max: 59 },
  hour: { name: "hour", min: 0, max: 23 },
  day: { name: "day of month", min: 1, max: 31 },
  month: { name: "month", min: 1, max: 12 },
  weekday: { name: "day of week", min: 0, max: 7 },
};

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Whether the field began with `*`: cron then ANDs the two day fields, otherwise it ORs them. */
  anyDay: boolean;
  anyWeekday: boolean;
}

const NUM = /^\d{1,2}$/;

function field(text: string, f: (typeof FIELDS)[keyof typeof FIELDS]): Set<number> {
  const fail = () => new TypeError(`invalid cron ${f.name} field`);
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const [range = "", step, extra] = item.split("/");
    if (extra !== undefined || (step !== undefined && !/^[1-9]\d{0,2}$/.test(step))) throw fail();
    let from: number;
    let to: number;
    if (range === "*") {
      [from, to] = [f.min, f.max];
    } else {
      const [a = "", b, more] = range.split("-");
      if (more !== undefined || !NUM.test(a) || (b !== undefined && !NUM.test(b))) throw fail();
      from = Number(a);
      to = b === undefined ? (step === undefined ? from : f.max) : Number(b);
      if (b === undefined && step !== undefined) throw fail(); // `5/10` is ambiguous across crons
    }
    if (from < f.min || to > f.max || from > to) throw fail();
    for (let n = from; n <= to; n += Number(step ?? 1)) out.add(n);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const [m = "", h = "", dom = "", mon = "", dow = "", ...extra] = expr.trim().split(/\s+/);
  if (!dow || extra.length > 0) throw new TypeError("cron expression needs 5 fields");
  const weekdays = field(dow, FIELDS.weekday);
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minutes: field(m, FIELDS.minute),
    hours: field(h, FIELDS.hour),
    days: field(dom, FIELDS.day),
    months: field(mon, FIELDS.month),
    weekdays,
    anyDay: dom.startsWith("*"),
    anyWeekday: dow.startsWith("*"),
  };
}

/** The first matching minute strictly after `after`. Throws when there is none within years. */
export function nextCronRun(expr: string | Cron, after: Date): Date {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const dayOk = (t: Date) => {
    const dom = c.days.has(t.getUTCDate());
    const dow = c.weekdays.has(t.getUTCDay());
    return c.anyDay || c.anyWeekday ? dom && dow : dom || dow;
  };
  let t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  // Skips whole months, days and hours that cannot match; 20k steps cover any real schedule
  // (the rarest, Feb 29, is at most 8 years away) and end a never-matching one.
  for (let i = 0; i < 20_000; i++) {
    const [y, mo, dd, h] = [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours()];
    if (!c.months.has(mo + 1)) t = new Date(Date.UTC(y, mo + 1, 1));
    else if (!dayOk(t)) t = new Date(Date.UTC(y, mo, dd + 1));
    else if (!c.hours.has(h)) t = new Date(Date.UTC(y, mo, dd, h + 1));
    else if (!c.minutes.has(t.getUTCMinutes())) t = new Date(t.getTime() + 60_000);
    else return t;
  }
  throw new RangeError("cron expression never fires");
}
