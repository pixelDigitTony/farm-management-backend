import { describe, expect, it } from "vitest";
import { isCalendarDate, reportRange } from "../src/lib/business-date.js";

describe("Manila business dates", () => {
  it.each(["2025-02-29", "2026-02-30", "2026-13-01", "2026-2-01", "invalid"])(
    "rejects %s",
    (date) => {
      expect(isCalendarDate(date)).toBe(false);
      expect(() => reportRange(date, date)).toThrow();
    },
  );
  it("includes the entire final Manila day independently of the server timezone", () => {
    const range = reportRange("2024-02-29", "2024-02-29");
    expect(range.from.toISOString()).toBe("2024-02-28T16:00:00.000Z");
    expect(range.to.toISOString()).toBe("2024-02-29T15:59:59.999Z");
  });
  it("defaults to the Manila month at UTC month rollover", () => {
    const range = reportRange(undefined, undefined, new Date("2026-08-31T18:00:00Z"));
    expect(range.from.toISOString()).toBe("2026-08-31T16:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-09-01T15:59:59.999Z");
  });
  it("rejects reversed ranges and repeated parameters", () => {
    expect(() => reportRange("2026-09-02", "2026-09-01")).toThrow();
    expect(() => reportRange(["2026-09-01"], undefined)).toThrow();
  });
});
