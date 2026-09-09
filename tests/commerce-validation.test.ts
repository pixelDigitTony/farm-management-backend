import { parse } from "valibot";
import { describe, expect, it } from "vitest";
import {
  catalogItemKey,
  hasEnabledCatalog,
  isOrderTransitionAllowed,
  normalizeProductInput,
  selectedCatalogReferences,
} from "../src/services/commerce.service.js";
import { catalogProductSchema, publicOrderSchema } from "../src/validation/commerce.js";

function clothingProduct() {
  return {
    name: "Miss V Shirt",
    description: "Cotton business shirt",
    category: "Clothing",
    productType: "CLOTHING" as const,
    mediaUrls: ["https://example.com/shirt.jpg"],
    basePrice: 350,
    availableQuantity: null,
    variants: [
      {
        variantId: "shirt-red-medium",
        name: "Red / Medium",
        sku: "SHIRT-RED-M",
        attributes: [
          { name: "Size", value: "M" },
          { name: "Color", value: "Red" },
        ],
        price: 375,
        availableQuantity: 5,
        isAvailable: true,
      },
    ],
    isFeatured: true,
    isOrderable: true,
    isActive: true,
  };
}

function pickupOrder() {
  return {
    idempotencyKey: "checkout_request_123456789",
    customer: { name: "Customer", phone: "+639171234567", email: "" },
    fulfillmentMethod: "PICKUP" as const,
    deliveryAddress: "",
    paymentMethod: "PAY_ON_PICKUP" as const,
    items: [
      {
        sourceType: "PRODUCT" as const,
        sourceId: "507f1f77bcf86cd799439011",
        variantId: "shirt-red-medium",
        quantity: 2,
      },
    ],
    customerNotes: "",
  };
}

describe("commerce validation", () => {
  it("accepts clothing variants and assigns missing variant ids", () => {
    const parsed = parse(catalogProductSchema, clothingProduct());
    expect(parsed.variants[0]?.price).toBe(375);
    const missingId = clothingProduct();
    const variant = missingId.variants[0];
    if (!variant) throw new Error("Expected a variant fixture");
    missingId.variants[0] = { ...variant, variantId: undefined as never };
    expect(
      normalizeProductInput(parse(catalogProductSchema, missingId)).variants[0]?.variantId,
    ).toBeTruthy();
  });

  it("rejects duplicate variants, unsafe media, and negative stock", () => {
    const duplicated = clothingProduct();
    const firstVariant = duplicated.variants[0];
    if (!firstVariant) throw new Error("Expected a clothing variant fixture");
    duplicated.variants.push({ ...structuredClone(firstVariant) });
    expect(() => parse(catalogProductSchema, duplicated)).toThrow();
    expect(() =>
      parse(catalogProductSchema, { ...clothingProduct(), mediaUrls: ["javascript:alert(1)"] }),
    ).toThrow();
    expect(() =>
      parse(catalogProductSchema, { ...clothingProduct(), availableQuantity: -1 }),
    ).toThrow();
  });

  it("validates pickup and delivery payment/address combinations", () => {
    expect(parse(publicOrderSchema, pickupOrder()).fulfillmentMethod).toBe("PICKUP");
    expect(() =>
      parse(publicOrderSchema, {
        ...pickupOrder(),
        fulfillmentMethod: "DELIVERY",
        paymentMethod: "CASH_ON_DELIVERY",
        deliveryAddress: "",
      }),
    ).toThrow();
    expect(
      parse(publicOrderSchema, {
        ...pickupOrder(),
        fulfillmentMethod: "DELIVERY",
        paymentMethod: "CASH_ON_DELIVERY",
        deliveryAddress: "Davao City",
      }).deliveryAddress,
    ).toBe("Davao City");
  });

  it("keeps manual menu references and detects automatic catalog visibility", () => {
    const snapshot = {
      sections: [
        {
          enabled: true,
          components: [
            {
              enabled: true,
              type: "MENU",
              content: { menuItemIds: ["menu-1"] },
            },
            {
              enabled: true,
              type: "CATALOG",
              content: {
                catalogItemRefs: [
                  { sourceType: "MENU_ITEM", sourceId: "menu-1" },
                  { sourceType: "PRODUCT", sourceId: "product-1" },
                ],
              },
            },
            {
              enabled: false,
              type: "CATALOG",
              content: {
                catalogItemRefs: [{ sourceType: "PRODUCT", sourceId: "hidden-product" }],
              },
            },
          ],
        },
      ],
    };
    const references = selectedCatalogReferences(snapshot);
    expect(references.map(catalogItemKey)).toEqual(["MENU_ITEM:menu-1"]);
    expect(hasEnabledCatalog(snapshot)).toBe(true);
    expect(hasEnabledCatalog({ sections: [{ ...snapshot.sections[0], enabled: false }] })).toBe(
      false,
    );
    expect(hasEnabledCatalog({ components: [{ type: "CATALOG", enabled: false }] })).toBe(false);
    expect(hasEnabledCatalog({ components: [{ type: "CATALOG" }] })).toBe(true);
  });

  it("enforces the forward order lifecycle", () => {
    expect(isOrderTransitionAllowed("PENDING", "CONFIRMED")).toBe(true);
    expect(isOrderTransitionAllowed("PENDING", "CANCELLED")).toBe(true);
    expect(isOrderTransitionAllowed("CONFIRMED", "PROCESSING")).toBe(true);
    expect(isOrderTransitionAllowed("PROCESSING", "READY")).toBe(true);
    expect(isOrderTransitionAllowed("READY", "COMPLETED")).toBe(true);
    expect(isOrderTransitionAllowed("READY", "PENDING")).toBe(false);
    expect(isOrderTransitionAllowed("COMPLETED", "CANCELLED")).toBe(false);
  });
});
