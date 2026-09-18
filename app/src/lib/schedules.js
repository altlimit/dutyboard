// Recurring duties, as a form rather than as a cron expression.
//
// The board stores a five-field cron expression and a timezone, because that is what a schedule
// is. Nobody should have to write one to say "every Monday at 9", so the form offers the four
// shapes people actually ask for and hands the expression to anyone who wants to write their own.
//
// The browser is also one of the two things that know what a timezone is worth (the other is a
// machine's daemon, which carries Go's timezone database). The board's function knows only the
// number it was last told, so this file works the offset out and the page sends it.

/** What the four presets mean, in cron. `day` and `time` come from the form. */
export const REPEATS = [
  { key: "weekday", label: "Every weekday", hint: "Monday to Friday" },
  { key: "weekly", label: "Every week", hint: "on a day you pick" },
  { key: "monthly", label: "Every month", hint: "on a date you pick" },
  { key: "custom", label: "Custom", hint: "a cron expression" },
];

export const DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The expression a draft means. */
export function cronOf(draft) {
  if (draft.repeat === "custom") return (draft.cron || "").trim();
  const [h, m] = (draft.time || "09:00").split(":").map((n) => Number(n) || 0);
  if (draft.repeat === "weekday") return `${m} ${h} * * 1-5`;
  if (draft.repeat === "monthly") return `${m} ${h} ${Number(draft.date) || 1} * *`;
  return `${m} ${h} * * ${Number(draft.day) || 1}`;
}

/** A blank form, and the form a stored schedule fills. The preset is recovered from the
 *  expression where it can be, so a schedule made here does not come back as "custom". */
export function scheduleDraft(row) {
  const base = { schedule_id: "", title: "", brief: "", priority: "next", repeat: "weekly", day: 1, date: 1, time: "09:00", cron: "0 9 * * 1", tz: browserZone() };
  if (!row) return base;
  const draft = { ...base, schedule_id: row.schedule_id, title: row.title, brief: row.brief, priority: row.priority, cron: row.cron, tz: row.tz || "UTC", repeat: "custom" };
  const m = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}) \* (\*|1-5|[0-6])$/.exec(String(row.cron || "").trim());
  if (m) {
    const [, minute, hour, date, dow] = m;
    draft.time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (date !== "*" && dow === "*") {
      draft.repeat = "monthly";
      draft.date = Number(date);
    } else if (date === "*" && dow === "1-5") {
      draft.repeat = "weekday";
    } else if (date === "*" && dow !== "*") {
      draft.repeat = "weekly";
      draft.day = Number(dow);
    }
  }
  return draft;
}

/** What goes to the board. The offset travels with it: the function cannot work out a zone. */
export function schedulePayload(draft) {
  return {
    title: draft.title.trim(),
    brief: draft.brief.trim(),
    priority: draft.priority,
    cron: cronOf(draft),
    tz: draft.tz,
    offset_min: zoneOffset(draft.tz),
  };
}

/**
 * Whether this browser knows the zone. A typo — "America/Chicagoo" — is otherwise silent: the
 * offset stays at zero, the schedule runs at the wrong hour, and the only sign is a line in one
 * machine's log.
 */
export function knownZone(tz) {
  if (!tz) return false;
  if (tz === "UTC") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Every zone this browser knows, for a list to pick from. Empty where it cannot say. */
export function allZones() {
  try {
    return Intl.supportedValuesOf("timeZone") || [];
  } catch {
    return [];
  }
}

/** This browser's own zone, e.g. "America/Chicago". Falls back to UTC where it cannot be had. */
export function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** What a zone is worth right now, in minutes from UTC — the number the board stores. */
export function zoneOffset(tz, when = new Date()) {
  if (!tz || tz === "UTC") return 0;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(when)
        .map((p) => [p.type, p.value]),
    );
    const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    return Math.round((local - Math.floor(when.getTime() / 1000) * 1000) / 60000);
  } catch {
    return 0;
  }
}

/** The offsets a board's schedules should be keeping, for /schedules/sync. */
export function zoneOffsets(schedules) {
  const out = {};
  for (const s of schedules || []) {
    const tz = s.tz || "UTC";
    if (!(tz in out)) out[tz] = zoneOffset(tz);
  }
  return out;
}

/** A stored schedule in words: "every Monday at 09:00". Falls back to the expression itself. */
export function repeatText(row) {
  const parts = String(row.cron || "").trim().split(/\s+/);
  if (parts.length !== 5) return row.cron || "";
  const [minute, hour, date, month, dow] = parts;
  const time = /^\d{1,2}$/.test(hour) && /^\d{1,2}$/.test(minute) ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : null;
  if (!time || month !== "*") return row.cron;
  if (date === "*" && dow === "1-5") return `every weekday at ${time}`;
  if (date === "*" && /^[0-6]$/.test(dow)) return `every ${DAY_NAMES[Number(dow)]} at ${time}`;
  if (dow === "*" && /^\d{1,2}$/.test(date)) return `on the ${ordinal(Number(date))} of each month at ${time}`;
  if (date === "*" && dow === "*") return `every day at ${time}`;
  return row.cron;
}

function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return `${n}${suffix}`;
}

/** A run, in the schedule's own zone: "Mon 21 Sep, 09:00". */
export function runText(ms, tz) {
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz || "UTC", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}
