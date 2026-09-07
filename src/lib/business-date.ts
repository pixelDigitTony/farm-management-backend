import { HttpError } from "./http-error.js";

const DAY_MS = 86_400_000;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function businessDate(now = new Date()): string {
  return new Date(now.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

export function businessDayStart(value: string): Date {
  if (!isCalendarDate(value)) throw new HttpError(422, "Use a valid calendar date (YYYY-MM-DD)");
  return new Date(`${value}T00:00:00.000+08:00`);
}

export function reportRange(from: unknown, to: unknown, now = new Date()) {
  const today = businessDate(now);
  const first = from === undefined ? `${today.slice(0, 7)}-01` : from;
  const last = to === undefined ? today : to;
  if (typeof first !== "string" || typeof last !== "string")
    throw new HttpError(422, "Report dates must be strings");
  const start = businessDayStart(first);
  const end = new Date(businessDayStart(last).getTime() + DAY_MS - 1);
  if (start > end) throw new HttpError(422, "The start date must not follow the end date");
  return { from: start, to: end };
}
