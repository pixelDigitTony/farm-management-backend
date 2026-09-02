import { Types } from "mongoose";
import { parse } from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogPrice, discountStatus } from "../src/lib/catalog-pricing.js";
import { CatalogDiscount, CatalogProduct } from "../src/models/index.js";
import {
  priceCatalogProducts,
  saveCatalogDiscount,
} from "../src/services/catalog-discount.service.js";
import { catalogDiscountInput } from "../src/validation/catalog-discount.js";

const businessId = new Types.ObjectId();
const productId = new Types.ObjectId();
const rule = {
  name: "Weekend",
  type: "PERCENTAGE" as const,
  value: 25,
  startsAt: "2030-01-01T00:00:00.000Z",
  endsAt: "2030-01-03T00:00:00.000Z",
  isEnabled: true,
};
const input = { ...rule, productIds: [String(productId)] };
afterEach(() => vi.restoreAllMocks());

describe("catalog discount pricing", () => {
  it("starts at the exact start time and ends at the exact end time", () => {
    expect(discountStatus(rule, new Date("2029-12-31T23:59:59.999Z"))).toBe("SCHEDULED");
    expect(catalogPrice(100, rule, new Date(rule.startsAt)).price).toBe("75.00");
    expect(catalogPrice(100, rule, new Date("2030-01-02T23:59:59.999Z")).price).toBe("75.00");
    expect(catalogPrice(100, rule, new Date(rule.endsAt)).price).toBe("100.00");
  });
  it("restores the original price when inactive or not yet started", () => {
    expect(catalogPrice(100, { ...rule, isEnabled: false }, new Date(rule.startsAt)).price).toBe(
      "100.00",
    );
    expect(catalogPrice(100, rule, new Date("2029-01-01")).price).toBe("100.00");
    expect(catalogPrice(100, null, new Date(rule.startsAt)).discountAmount).toBe("0.00");
  });
  it("rounds per unit, supports 100 percent, and caps fixed discounts at zero", () => {
    expect(catalogPrice("19.99", { ...rule, value: 15 }, new Date(rule.startsAt))).toMatchObject({
      price: "16.99",
      discountAmount: "3.00",
    });
    expect(
      catalogPrice(25, { ...rule, type: "FIXED", value: 50 }, new Date(rule.startsAt)).price,
    ).toBe("0.00");
    expect(catalogPrice(25, { ...rule, value: 100 }, new Date(rule.startsAt)).price).toBe("0.00");
  });
  it("prices every variant but retains its editable original price", async () => {
    vi.spyOn(CatalogDiscount, "find").mockReturnValue({
      lean: async () => [{ ...rule, _id: new Types.ObjectId(), productIds: [productId] }],
    } as any);
    const products = [
      { _id: productId, basePrice: 100, variants: [{ variantId: "large", price: 200 }] },
    ];
    const priced = await priceCatalogProducts(businessId, products, new Date(rule.startsAt));
    expect(priced[0].price).toBe("75.00");
    expect(priced[0].variants[0]).toMatchObject({
      price: 200,
      effectivePrice: "150.00",
      originalPrice: "200.00",
    });
    expect(products[0]?.variants[0]?.price).toBe(200);
    expect(CatalogDiscount.find).toHaveBeenCalledWith(
      expect.objectContaining({ businessId, isEnabled: true }),
    );
  });
});

describe("promotion validation and assignments", () => {
  it("rejects invalid amounts, dates, duplicates, and missing products", () => {
    expect(parse(catalogDiscountInput, input).value).toBe(25);
    for (const changes of [
      { value: 0 },
      { value: -1 },
      { value: 101 },
      { value: Number.NaN },
      { productIds: [] },
      { productIds: [String(productId), String(productId)] },
      { endsAt: rule.startsAt },
      { startsAt: "not-a-date" },
    ]) {
      expect(() => parse(catalogDiscountInput, { ...input, ...changes })).toThrow();
    }
  });
  it("rejects foreign or archived products without saving anything", async () => {
    vi.spyOn(CatalogDiscount, "init").mockResolvedValue(CatalogDiscount);
    vi.spyOn(CatalogProduct, "find").mockReturnValue({
      select: () => ({ lean: async () => [] }),
    } as any);
    const create = vi.spyOn(CatalogDiscount, "create");
    await expect(saveCatalogDiscount(businessId, input)).rejects.toThrow(
      "Select active products belonging to your business",
    );
    expect(create).not.toHaveBeenCalled();
    expect(CatalogProduct.find).toHaveBeenCalledWith(
      expect.objectContaining({ businessId, isActive: true }),
    );
  });
  it("identifies conflicting products and does not partially apply a bulk promotion", async () => {
    vi.spyOn(CatalogDiscount, "init").mockResolvedValue(CatalogDiscount);
    vi.spyOn(CatalogProduct, "find").mockReturnValue({
      select: () => ({ lean: async () => [{ _id: productId, name: "Shirt" }] }),
    } as any);
    vi.spyOn(CatalogDiscount, "updateMany").mockResolvedValue({} as any);
    vi.spyOn(CatalogDiscount, "find").mockReturnValue({
      lean: async () => [{ productIds: [productId] }],
    } as any);
    const create = vi.spyOn(CatalogDiscount, "create");
    await expect(saveCatalogDiscount(businessId, input)).rejects.toThrow("Shirt");
    expect(create).not.toHaveBeenCalled();
  });
  it("has a database constraint preventing concurrent enabled assignments", () => {
    expect(CatalogDiscount.schema.indexes()).toContainEqual([
      { businessId: 1, productIds: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { isEnabled: true } }),
    ]);
  });
});
