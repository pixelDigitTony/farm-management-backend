import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import { calculateReceiptCorrection } from "../src/services/farm-operations.service.js";

describe("inventory receipt corrections", () => {
  it("accepts MongoDB Decimal128 values loaded from receipt records", () => {
    const result = calculateReceiptCorrection(
      mongoose.Types.Decimal128.fromString("10.000"),
      mongoose.Types.Decimal128.fromString("6.000"),
      8,
      false,
    );

    expect(result.newRemaining.toString()).toBe("4");
  });

  it("preserves stock already consumed while correcting the receipt", () => {
    const result = calculateReceiptCorrection(10, 6, 8, false);

    expect(result.consumed.toString()).toBe("4");
    expect(result.newRemaining.toString()).toBe("4");
    expect(result.stockDelta.toString()).toBe("-2");
  });

  it("rejects a corrected quantity below the quantity already consumed", () => {
    expect(() => calculateReceiptCorrection(10, 6, 3, false)).toThrow(
      "Quantity cannot be less than 4 because that stock has already been used",
    );
  });

  it("allows changing the item only while the whole receipt remains available", () => {
    expect(calculateReceiptCorrection(10, 10, 12, true).newRemaining.toString()).toBe("12");
    expect(() => calculateReceiptCorrection(10, 9, 12, true)).toThrow(
      "The inventory item cannot be changed after stock from this lot was used",
    );
  });
});
