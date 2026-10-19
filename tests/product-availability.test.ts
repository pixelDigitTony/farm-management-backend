import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  type AvailabilitySchedule,
  availabilityInfo,
  availabilityScheduleSchema,
  effectiveActive,
  scheduleMatchesDate,
  startOfLocalDate,
} from "../src/lib/product-availability.js";

const zone = "Asia/Manila";
describe("calendar-based product availability", () => {
  it("uses the configured local day and manual deactivation takes precedence", () => {
    const rule: AvailabilitySchedule = { mode: "WEEKDAYS", timezone: zone, weekdays: [1, 5] };
    expect(
      effectiveActive(
        { isActive: true, availabilitySchedule: rule },
        new Date("2026-10-18T16:00:00Z"),
      ),
    ).toBe(true);
    expect(
      effectiveActive(
        { isActive: true, availabilitySchedule: rule },
        new Date("2026-10-18T15:59:59Z"),
      ),
    ).toBe(false);
    expect(
      effectiveActive({
        isActive: false,
        availabilitySchedule: { mode: "ALWAYS", timezone: zone },
      }),
    ).toBe(false);
  });
  it("defines monthly weeks by date ranges, including February and leap years", () => {
    const rule: AvailabilitySchedule = {
      mode: "MONTH_WEEKS",
      timezone: zone,
      weeksOfMonth: [2, 4],
    };
    for (const day of ["2026-10-08", "2026-10-14", "2026-10-22", "2026-10-28"])
      expect(scheduleMatchesDate(rule, day)).toBe(true);
    for (const day of ["2026-10-07", "2026-10-15", "2026-10-21", "2026-10-29"])
      expect(scheduleMatchesDate(rule, day)).toBe(false);
    const leap: AvailabilitySchedule = { mode: "MONTH_WEEKS", timezone: zone, weeksOfMonth: [5] };
    expect(scheduleMatchesDate(leap, "2028-02-29")).toBe(true);
    expect(scheduleMatchesDate(leap, "2027-02-28")).toBe(false);
  });
  it("supports yearly months, exact custom dates, inclusive bounds and expiry", () => {
    expect(
      scheduleMatchesDate(
        { mode: "YEAR_MONTHS", timezone: zone, monthsOfYear: [11, 12] },
        "2027-11-01",
      ),
    ).toBe(true);
    const rule: AvailabilitySchedule = {
      mode: "CUSTOM_DATES",
      timezone: zone,
      dates: ["2026-12-24", "2027-01-02"],
    };
    expect(scheduleMatchesDate(rule, "2027-12-24")).toBe(false);
    expect(scheduleMatchesDate(rule, "2027-01-02")).toBe(true);
    const bounded: AvailabilitySchedule = {
      mode: "WEEKDAYS",
      timezone: zone,
      weekdays: [1],
      startsOn: "2026-10-19",
      endsOn: "2026-10-19",
    };
    expect(
      availabilityInfo(
        { isActive: true, availabilitySchedule: bounded },
        new Date("2026-10-19T15:59:59Z"),
      ).effectiveActive,
    ).toBe(true);
    expect(
      availabilityInfo(
        { isActive: true, availabilitySchedule: bounded },
        new Date("2026-10-19T16:00:00Z"),
      ).availabilityStatus,
    ).toBe("EXPIRED");
  });
  it("finds exact local midnight transitions, including DST-short and long days", () => {
    expect(startOfLocalDate("2026-10-19", zone)).toBe("2026-10-18T16:00:00.000Z");
    expect(
      Date.parse(startOfLocalDate("2026-03-09", "America/New_York")) -
        Date.parse(startOfLocalDate("2026-03-08", "America/New_York")),
    ).toBe(23 * 3600000);
    expect(
      Date.parse(startOfLocalDate("2026-11-02", "America/New_York")) -
        Date.parse(startOfLocalDate("2026-11-01", "America/New_York")),
    ).toBe(25 * 3600000);
  });
  it("reports the next active date and keeps manually inactive rules inactive", () => {
    const rule: AvailabilitySchedule = {
      mode: "CUSTOM_DATES",
      timezone: zone,
      dates: ["2040-01-01"],
    };
    expect(
      availabilityInfo({ isActive: true, availabilitySchedule: rule }, new Date("2026-01-01Z"))
        .nextActiveAt,
    ).toBe("2039-12-31T16:00:00.000Z");
    expect(
      availabilityInfo({ isActive: false, availabilitySchedule: rule }).availabilityStatus,
    ).toBe("INACTIVE");
  });
  it.each([
    { mode: "WEEKDAYS", timezone: zone, weekdays: [] },
    { mode: "MONTH_WEEKS", timezone: zone, weeksOfMonth: [6] },
    { mode: "YEAR_MONTHS", timezone: zone, monthsOfYear: [1, 1] },
    { mode: "CUSTOM_DATES", timezone: zone, dates: ["2027-02-29"] },
    { mode: "ALWAYS", timezone: "Invalid/Timezone" },
    { mode: "ALWAYS", timezone: zone, weekdays: [1] },
    {
      mode: "WEEKDAYS",
      timezone: zone,
      weekdays: [1],
      startsOn: "2026-11-02",
      endsOn: "2026-11-01",
    },
  ])("rejects invalid or ambiguous schedules: %j", (input) =>
    expect(v.safeParse(availabilityScheduleSchema, input).success).toBe(false),
  );
});
