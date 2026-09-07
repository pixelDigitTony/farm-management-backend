import { describe, expect, it } from "vitest";
import { resourceQuery, resourceUpdates } from "../src/lib/resource-input.js";

describe("generic resource boundary", () => {
  const fields = new Set(["_id", "createdAt", "name", "status"]);
  it.each(["businessId", "$where", "name.value", "constructor", "missing"])(
    "rejects unsafe or unknown filter %s",
    (field) => {
      expect(() => resourceQuery({ [field]: "other-business" }, fields)).toThrow();
    },
  );
  it.each(["0", "-1", "NaN", "1.5", "1e2", "", ["1", "2"]])("rejects invalid pages %j", (page) => {
    expect(() => resourceQuery({ page }, fields)).toThrow();
  });
  it("bounds pages and adds deterministic ordering", () => {
    expect(resourceQuery({ page: "2", limit: "100", sort: "name" }, fields)).toEqual({
      page: 2,
      limit: 100,
      filter: {},
      sort: { name: 1, _id: 1 },
    });
    expect(() => resourceQuery({ limit: "101" }, fields)).toThrow();
  });
  it.each([
    { $set: { businessId: "other" } },
    { "currentStockCached.x": 1 },
    { nested: { $inc: { stock: 1 } } },
    [],
  ])("rejects operator and malformed updates", (value) =>
    expect(() => resourceUpdates(value)).toThrow(),
  );
  it("keeps identity and cached balances server-owned", () => {
    expect(resourceUpdates({ _id: "other", businessId: "other", name: "Updated" })).toEqual({
      name: "Updated",
    });
    expect(() =>
      resourceUpdates({ currentBalanceCached: 999 }, new Set(["currentBalanceCached"])),
    ).toThrow();
  });
});
