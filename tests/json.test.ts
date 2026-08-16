import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import { mongoJsonReplacer } from "../src/lib/json.js";

describe("API JSON serialization", () => {
  it("serializes MongoDB Decimal128 values as numeric strings", () => {
    const balance = mongoose.Types.Decimal128.fromString("0.00");

    expect(
      JSON.parse(JSON.stringify({ currentBalanceCached: balance }, mongoJsonReplacer)),
    ).toEqual({ currentBalanceCached: "0.00" });
  });

  it("does not change ordinary response values", () => {
    const response = { name: "Cash on hand", active: true, total: 0 };

    expect(JSON.parse(JSON.stringify(response, mongoJsonReplacer))).toEqual(response);
  });
});
