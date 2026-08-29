import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import {
  calculateInventoryReceipt,
  calculateReceiptCorrection,
} from "../src/services/farm-operations.service.js";

describe("inventory receipt corrections", () => {
  it("separates purchased units from the base-unit measurement", () => {
    const result = calculateInventoryReceipt({
      purchaseQuantity: 3,
      measurementPerPurchaseUnit: 50,
      totalPurchaseCost: 5400,
    });

    expect(result.baseQuantity.toString()).toBe("150");
    expect(result.baseUnitCost.toString()).toBe("36");
    expect(result.totalCost.toString()).toBe("5400");
  });

  it("keeps legacy base-unit receipt inputs compatible", () => {
    const result = calculateInventoryReceipt({ quantity: 10, unitCost: 25 });

    expect(result.purchaseQuantity.toString()).toBe("10");
    expect(result.measurementPerPurchaseUnit.toString()).toBe("1");
    expect(result.baseQuantity.toString()).toBe("10");
    expect(result.totalCost.toString()).toBe("250");
  });

  it("rejects partially separated receipt inputs", () => {
    expect(() =>
      calculateInventoryReceipt({ purchaseQuantity: 2, measurementPerPurchaseUnit: 25 }),
    ).toThrow("Enter the purchased quantity");
  });

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
