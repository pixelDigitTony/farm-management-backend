import { HttpError } from "./http-error.js";

export type PublicAccess = {
  mode: "INACTIVE" | "IMMEDIATE" | "SCHEDULED" | "LIMITED";
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  timezone: string;
};
export const inactiveAccess = () => ({
  mode: "INACTIVE" as const,
  startsAt: null,
  endsAt: null,
  timezone: "Asia/Manila",
});
export function resolveLandingAccess(
  page: {
    isPublished?: boolean;
    publishedSnapshot?: unknown;
    isArchived?: boolean;
    publicAccess?: PublicAccess | null;
  },
  now = new Date(),
) {
  const access = page.publicAccess;
  const start = access?.startsAt ? new Date(access.startsAt).getTime() : null;
  const end = access?.endsAt ? new Date(access.endsAt).getTime() : null;
  const time = now.getTime();
  const invalid =
    access &&
    (!["INACTIVE", "IMMEDIATE", "SCHEDULED", "LIMITED"].includes(access.mode) ||
      (["SCHEDULED", "LIMITED"].includes(access.mode) &&
        (start === null || !Number.isFinite(start))) ||
      (access.mode === "LIMITED" &&
        (end === null || !Number.isFinite(end) || end <= (start ?? Infinity))));
  const accessStatus =
    page.isArchived || !page.isPublished || !page.publishedSnapshot
      ? "Unpublished"
      : invalid || access?.mode === "INACTIVE"
        ? "Inactive"
        : end !== null && (!Number.isFinite(end) || time >= end)
          ? "Expired"
          : start !== null && (!Number.isFinite(start) || time < start)
            ? "Scheduled"
            : "Active";
  const next = accessStatus === "Scheduled" ? start : accessStatus === "Active" ? end : null;
  return {
    accessStatus,
    isAccessible: accessStatus === "Active",
    serverTime: now.toISOString(),
    nextTransitionAt: next && Number.isFinite(next) ? new Date(next).toISOString() : null,
  };
}

// Resolve a wall-clock value against an IANA timezone. Require exactly one matching
// instant: DST gaps and repeated hours need a different, unambiguous selection.
export function localInstant(value: unknown, timezone: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new HttpError(422, "Choose both date and time");
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const wall = (date: Date) => formatter.format(date).replace(" ", "T");
  const nominal = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(nominal)) throw new HttpError(422, "Choose a valid date and time");
  const offsets = new Set<number>();
  for (const hours of [-36, 0, 36]) {
    const instant = new Date(nominal + hours * 3600000);
    offsets.add(Date.parse(`${wall(instant)}:00Z`) - instant.getTime());
  }
  const matches = [...offsets]
    .map((offset) => new Date(nominal - offset))
    .filter((date) => wall(date) === value);
  if (matches.length !== 1)
    throw new HttpError(422, "This local time is invalid or ambiguous. Choose another time.");
  return matches[0]!;
}

export function parseAccess(
  input: {
    mode: string;
    timezone: string;
    startLocal?: string;
    endLocal?: string;
    startNow?: boolean;
  },
  now = new Date(),
): PublicAccess {
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(now);
  } catch {
    throw new HttpError(422, "Choose a valid timezone");
  }
  const startsAt =
    input.mode === "SCHEDULED" || input.mode === "LIMITED"
      ? input.startNow && input.mode === "LIMITED"
        ? now
        : localInstant(input.startLocal, input.timezone)
      : null;
  const endsAt = input.mode === "LIMITED" ? localInstant(input.endLocal, input.timezone) : null;
  if (startsAt && !input.startNow && startsAt <= now)
    throw new HttpError(422, "Choose a future start time");
  if (endsAt && (endsAt <= (startsAt ?? now) || endsAt <= now))
    throw new HttpError(422, "End time must be after the start and the current time");
  return { mode: input.mode as PublicAccess["mode"], startsAt, endsAt, timezone: input.timezone };
}
