import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { myDayNextTransition, myDayStatus, resolveMyDay } from "../src/lib/catalog-my-day.js";
import { myDayDates } from "../src/services/catalog-my-day.service.js";
import { myDayInput } from "../src/validation/catalog-my-day.js";

const start = "2030-01-01T00:00:00Z",
  end = "2030-01-02T00:00:00Z";
const campaign = {
  _id: "b",
  revision: 1,
  heading: "Harvest",
  productIds: ["p2", "p1", "hidden"],
  startsAt: start,
  endsAt: end,
  isEnabled: true,
};
const product = (id: string, isAvailable = true) => ({
  key: `PRODUCT:${id}`,
  sourceId: id,
  sourceType: "PRODUCT",
  effectiveActive: true,
  isAvailable,
});
const items = [product("p1"), product("p2")];
describe("My Day public resolution", () => {
  it.each([
    ["2029-12-31T23:59:59.999Z", false],
    [start, true],
    ["2030-01-01T23:59:59.999Z", true],
    [end, false],
  ])("resolves the exact schedule boundary %s", (instant, active) => {
    expect(Boolean(resolveMyDay([campaign], items, "SHOP", new Date(instant)))).toBe(active);
  });
  it("preserves owner order and only returns existing public product keys", () => {
    expect(resolveMyDay([campaign], items, "SHOP", new Date(start))?.productKeys).toEqual([
      "PRODUCT:p2",
      "PRODUCT:p1",
    ]);
    expect(
      resolveMyDay(
        [campaign],
        [{ ...product("p1"), sourceType: "MENU_ITEM" }],
        "SHOP",
        new Date(start),
      ),
    ).toBeNull();
  });
  it("filters shop stock, allows catalog details, and excludes off-schedule products", () => {
    const unavailable = [product("p1", false), { ...product("p2"), effectiveActive: false }];
    expect(resolveMyDay([campaign], unavailable, "SHOP", new Date(start))).toBeNull();
    expect(resolveMyDay([campaign], unavailable, "CATALOG", new Date(start))?.productKeys).toEqual([
      "PRODUCT:p1",
    ]);
    expect(resolveMyDay([campaign], unavailable, "INQUIRY", new Date(start))?.productKeys).toEqual([
      "PRODUCT:p1",
    ]);
  });
  it("selects latest start then ascending ID and falls back if the winner is empty", () => {
    const latest = { ...campaign, _id: "c", startsAt: "2030-01-01T12:00:00Z" };
    expect(resolveMyDay([campaign, latest], items, "SHOP", new Date("2030-01-01T13:00Z"))?.id).toBe(
      "c",
    );
    expect(
      resolveMyDay([campaign, { ...campaign, _id: "a" }], items, "SHOP", new Date(start))?.id,
    ).toBe("a");
    expect(
      resolveMyDay(
        [{ ...latest, productIds: [] }, campaign],
        items,
        "SHOP",
        new Date("2030-01-01T13:00Z"),
      )?.id,
    ).toBe("b");
  });
  it("computes future boundaries even before any campaign is active and excludes disabled windows", () => {
    expect(myDayNextTransition([campaign], new Date("2029-12-31"))).toBe(
      new Date(start).toISOString(),
    );
    expect(myDayNextTransition([campaign], new Date(start))).toBe(new Date(end).toISOString());
    expect(myDayNextTransition([{ ...campaign, isEnabled: false }], new Date(start))).toBeNull();
    expect(myDayStatus({ ...campaign, isEnabled: false }, new Date(end))).toBe("Disabled");
  });
});
describe("My Day validation", () => {
  const input = {
    name: "Harvest",
    heading: "My Day",
    landingPageId: "507f1f77bcf86cd799439010",
    productIds: ["507f1f77bcf86cd799439011"],
    timezone: "Asia/Manila",
    startsAt: start,
    endsAt: end,
  };
  it.each([
    { productIds: [] },
    { productIds: [...input.productIds, ...input.productIds] },
    { timezone: "Invalid/Zone" },
    { startsAt: "2030-01-01T00:00" },
    { startNow: true },
    { businessId: "spoofed" },
  ])("rejects malformed or unsafe input %j", (changes) => {
    expect(v.safeParse(myDayInput, { ...input, ...changes }).success).toBe(false);
  });
  it("resolves Start now on the server and rejects expired creation", () => {
    const now = new Date("2029-12-31T12:00Z");
    const parsed = v.parse(myDayInput, { ...input, startsAt: undefined, startNow: true });
    expect(myDayDates(parsed, now, true).startsAt).toBe(now);
    expect(() => myDayDates(v.parse(myDayInput, input), new Date(end), true)).toThrow("future");
    expect(() => myDayDates(v.parse(myDayInput, { ...input, endsAt: start }), now, false)).toThrow(
      "after start",
    );
  });
});
