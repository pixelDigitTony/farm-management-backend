import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Business,
  CatalogDiscount,
  CatalogProduct,
  CustomerOrder,
  LandingPage,
  MenuItem,
} from "../src/models/index.js";
import { createPublicOrder } from "../src/services/commerce.service.js";
import type { PublicOrderInput } from "../src/validation/commerce.js";

const productId = new Types.ObjectId();
const promotionId = new Types.ObjectId();
let promotion: any;
function orderInput(price = 75): PublicOrderInput {
  return {
    idempotencyKey: "discount_test_checkout_123",
    customer: { name: "Test", phone: "123456", email: "" },
    fulfillmentMethod: "PICKUP",
    paymentMethod: "PAY_ON_PICKUP",
    deliveryAddress: "",
    customerNotes: "",
    items: [
      {
        sourceType: "PRODUCT",
        sourceId: String(productId),
        variantId: "large",
        quantity: 2,
        expectedUnitPrice: price,
      },
    ],
    expectedTotal: price * 2,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T01:00:00Z"));
  promotion = {
    _id: promotionId,
    productIds: [productId],
    name: "Sale",
    type: "PERCENTAGE",
    value: 25,
    startsAt: new Date("2030-01-01T00:00:00Z"),
    endsAt: new Date("2030-01-02T00:00:00Z"),
    isEnabled: true,
  };
  vi.spyOn(LandingPage, "findOne").mockReturnValue({
    lean: async () => ({
      _id: new Types.ObjectId(),
      businessId: new Types.ObjectId(),
      slug: "test",
      publishedSnapshot: {
        commerce: { orderingEnabled: true },
        sections: [
          {
            enabled: true,
            components: [
              {
                enabled: true,
                type: "CATALOG",
                content: {
                  catalogItemRefs: [{ sourceType: "PRODUCT", sourceId: String(productId) }],
                },
              },
            ],
          },
        ],
      },
    }),
  } as any);
  vi.spyOn(Business, "exists").mockResolvedValue({ _id: new Types.ObjectId() });
  vi.spyOn(CustomerOrder, "findOne").mockResolvedValue(null);
  vi.spyOn(MenuItem, "find").mockResolvedValue([]);
  vi.spyOn(CatalogProduct, "find").mockResolvedValue([
    {
      _id: productId,
      id: String(productId),
      name: "Shirt",
      isActive: true,
      isOrderable: true,
      basePrice: 50,
      variants: [
        { variantId: "large", name: "Large", price: 100, isAvailable: true, availableQuantity: 5 },
      ],
    },
  ] as any);
  vi.spyOn(CatalogDiscount, "find").mockReturnValue({
    lean: async () => (promotion.isEnabled ? [promotion] : []),
  } as any);
  vi.spyOn(CustomerOrder, "create").mockImplementation(async (data: any) => data);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("discounted checkout", () => {
  it("uses variant pricing and snapshots the discount and original price", async () => {
    const result = await createPublicOrder("test", orderInput());
    expect(result.created).toBe(true);
    expect(result.order.items[0]).toMatchObject({
      unitPrice: "75",
      originalUnitPrice: "100.00",
      discountAmount: "25.00",
      quantity: 2,
      lineTotal: "150",
      discountSnapshot: { promotionId, name: "Sale", value: 25 },
    });
    expect(result.order.total).toBe("150.00");
  });
  it.each(["expired", "inactive"])(
    "rejects stale cart prices when the promotion is %s",
    async (state) => {
      if (state === "expired") promotion.endsAt = new Date("2030-01-01T01:00:00Z");
      else promotion.isEnabled = false;
      await expect(createPublicOrder("test", orderInput())).rejects.toMatchObject({
        status: 409,
        code: "PRICES_CHANGED",
        details: { total: "200.00" },
      });
      expect(CustomerOrder.create).not.toHaveBeenCalled();
      const accepted = await createPublicOrder("test", orderInput(100));
      expect(accepted.order.items[0].discountSnapshot).toBeNull();
    },
  );
  it("requires price review for older product carts and tampered totals", async () => {
    const input = orderInput();
    delete input.items[0]?.expectedUnitPrice;
    await expect(createPublicOrder("test", input)).rejects.toMatchObject({
      code: "PRICES_CHANGED",
    });
    await expect(
      createPublicOrder("test", { ...orderInput(), expectedTotal: 1 }),
    ).rejects.toMatchObject({ code: "PRICES_CHANGED" });
    expect(CustomerOrder.create).not.toHaveBeenCalled();
  });
  it("returns the existing order on retry even after a sale expires", async () => {
    const previous = { _id: new Types.ObjectId(), total: "150.00" };
    vi.mocked(CustomerOrder.findOne).mockResolvedValue(previous as any);
    promotion.isEnabled = false;
    const result = await createPublicOrder("test", orderInput());
    expect(result).toEqual({ order: previous, created: false });
    expect(CustomerOrder.create).not.toHaveBeenCalled();
  });
});
