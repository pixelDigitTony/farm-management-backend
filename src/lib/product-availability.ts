import * as v from "valibot";

export function validLocalDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
const date = v.pipe(v.string(), v.check(validLocalDate, "Choose a valid calendar date"));
const timezone = v.pipe(v.string(), v.check(validTimezone, "Choose a valid timezone"));
const numbers = (max: number) =>
  v.pipe(
    v.array(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(max))),
    v.minLength(1),
    v.maxLength(max),
    v.check((items) => new Set(items).size === items.length, "Select each option once"),
  );
const bounds = { startsOn: v.optional(date), endsOn: v.optional(date) };
export const availabilityScheduleSchema = v.pipe(
  v.variant("mode", [
    v.strictObject({ mode: v.literal("ALWAYS"), timezone }),
    v.strictObject({ mode: v.literal("WEEKDAYS"), timezone, weekdays: numbers(7), ...bounds }),
    v.strictObject({
      mode: v.literal("MONTH_WEEKS"),
      timezone,
      weeksOfMonth: numbers(5),
      ...bounds,
    }),
    v.strictObject({
      mode: v.literal("YEAR_MONTHS"),
      timezone,
      monthsOfYear: numbers(12),
      ...bounds,
    }),
    v.strictObject({
      mode: v.literal("CUSTOM_DATES"),
      timezone,
      dates: v.pipe(
        v.array(date),
        v.minLength(1),
        v.maxLength(2000),
        v.check((items) => new Set(items).size === items.length, "Select each date once"),
      ),
    }),
  ]),
  v.check(
    (rule) => !("startsOn" in rule && rule.startsOn && rule.endsOn && rule.startsOn > rule.endsOn),
    "End date must be on or after start date",
  ),
);
export type AvailabilitySchedule = v.InferOutput<typeof availabilityScheduleSchema>;
export const alwaysAvailable = (timezone = "Asia/Manila"): AvailabilitySchedule => ({
  mode: "ALWAYS",
  timezone,
});
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localDateAt(now: Date, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(now);
  return ["year", "month", "day"].map((key) => parts.find((p) => p.type === key)!.value).join("-");
}
export function shiftDate(date: string, days: number) {
  return new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
}
export function scheduleMatchesDate(rule: AvailabilitySchedule, date: string): boolean {
  if (rule.mode === "ALWAYS") return true;
  if (rule.mode === "CUSTOM_DATES") return rule.dates.includes(date);
  if ((rule.startsOn && date < rule.startsOn) || (rule.endsOn && date > rule.endsOn)) return false;
  if (rule.mode === "WEEKDAYS") return rule.weekdays.includes(new Date(date).getUTCDay() || 7);
  if (rule.mode === "MONTH_WEEKS")
    return rule.weeksOfMonth.includes(Math.ceil(Number(date.slice(8)) / 7));
  return rule.monthsOfYear.includes(Number(date.slice(5, 7)));
}
export function effectiveActive(
  product: { isActive?: boolean; availabilitySchedule?: AvailabilitySchedule },
  now = new Date(),
) {
  const rule = product.availabilitySchedule ?? alwaysAvailable();
  return product.isActive !== false && scheduleMatchesDate(rule, localDateAt(now, rule.timezone));
}
// Find the first actual instant in a local date, including timezone/DST transitions.
export function startOfLocalDate(date: string, timezone: string) {
  const nominal = Date.parse(date);
  let low = nominal - 36 * 3600000,
    high = nominal + 36 * 3600000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDateAt(new Date(middle), timezone) < date) low = middle;
    else high = middle;
  }
  return new Date(high).toISOString();
}
export function scheduleSummary(rule: AvailabilitySchedule) {
  const days = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const months = [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  if (rule.mode === "ALWAYS") return "Always active";
  if (rule.mode === "CUSTOM_DATES")
    return `${rule.dates.length} specific calendar date${rule.dates.length === 1 ? "" : "s"}`;
  const text =
    rule.mode === "WEEKDAYS"
      ? rule.weekdays.map((d) => days[d]).join(", ")
      : rule.mode === "MONTH_WEEKS"
        ? rule.weeksOfMonth
            .map((w) => `Week ${w} (${(w - 1) * 7 + 1}–${w === 5 ? "month end" : w * 7})`)
            .join(", ")
        : rule.monthsOfYear.map((m) => months[m]).join(", ");
  return `${text}${rule.startsOn ? ` from ${rule.startsOn}` : ""}${rule.endsOn ? ` through ${rule.endsOn}` : ""}`;
}
export function availabilityInfo(
  product: { isActive?: boolean; availabilitySchedule?: AvailabilitySchedule },
  now = new Date(),
) {
  const rule = product.availabilitySchedule ?? alwaysAvailable();
  const today = localDateAt(now, rule.timezone);
  const active = effectiveActive(product, now);
  let nextActiveDate: string | undefined, transitionDate: string | undefined;
  if (product.isActive !== false && rule.mode !== "ALWAYS") {
    if (rule.mode === "CUSTOM_DATES") {
      if (!active) nextActiveDate = [...rule.dates].sort().find((d) => d > today);
      else {
        let candidate = shiftDate(today, 1);
        while (rule.dates.includes(candidate)) candidate = shiftDate(candidate, 1);
        transitionDate = candidate;
      }
    } else if (!rule.endsOn || rule.endsOn >= today) {
      let candidate = shiftDate(today, 1);
      if (!active && rule.startsOn && rule.startsOn > candidate) candidate = rule.startsOn;
      for (let i = 0; i < 366 * 8; i++, candidate = shiftDate(candidate, 1)) {
        if (rule.endsOn && candidate > rule.endsOn && !active) break;
        if (scheduleMatchesDate(rule, candidate) !== active) {
          if (active) transitionDate = candidate;
          else nextActiveDate = candidate;
          break;
        }
      }
    }
  }
  const nextActiveAt = nextActiveDate ? startOfLocalDate(nextActiveDate, rule.timezone) : null;
  return {
    effectiveActive: active,
    availabilityStatus:
      product.isActive === false
        ? "INACTIVE"
        : rule.mode === "ALWAYS"
          ? "ALWAYS"
          : active
            ? "ACTIVE_NOW"
            : nextActiveAt
              ? "SCHEDULED"
              : "EXPIRED",
    scheduleSummary: scheduleSummary(rule),
    nextActiveAt,
    nextTransitionAt: transitionDate
      ? startOfLocalDate(transitionDate, rule.timezone)
      : nextActiveAt,
  };
}
