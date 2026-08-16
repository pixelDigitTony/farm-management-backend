import { describe, expect, it } from "vitest";
import {
  calculateMenuPrice,
  calculateRecipeIngredientUsage,
  calculateSlaughter,
} from "../src/services/calculation.service.js";

describe("business calculations", () => {
  it("calculates slaughter yield and cost per usable kilogram", () => {
    const result = calculateSlaughter({
      raisingCost: 12000,
      liveWeightKg: 100,
      carcassWeightKg: 75,
      costs: [{ name: "Slaughter", amount: 1000 }],
      parts: [
        { name: "Meat", classification: "MEAT", weightKg: 60, pricePerKg: 300 },
        { name: "Waste", classification: "WASTE", weightKg: 10 },
      ],
    });
    expect(result.totalCost).toBe("13000.00");
    expect(result.costPerUsableKg).toBe("216.67");
    expect(result.usableYieldPercentage).toBe("60.000");
  });

  it("suggests a menu price from food cost target", () => {
    const result = calculateMenuPrice({
      ingredients: [
        { quantity: 2, unitCost: 250 },
        { quantity: 1, unitCost: 100 },
      ],
      additionalCosts: 100,
      servings: 10,
      sellingPrice: 100,
      targetFoodCostPercent: 35,
    });
    expect(result.costPerServing).toBe("70.00");
    expect(result.suggestedPrice).toBe("200.00");
    expect(result.profitPerServing).toBe("30.00");
  });

  it("scales recipe inventory usage by servings sold", () => {
    expect(calculateRecipeIngredientUsage("2.5", 4, 10)).toBe("1");
    expect(calculateRecipeIngredientUsage("0.125", 3, 8)).toBe("0.046875");
  });
});
