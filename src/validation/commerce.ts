import * as v from "valibot";

const requiredText = (maximum: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maximum));
const optionalText = (maximum: number) =>
  v.optional(v.pipe(v.string(), v.trim(), v.maxLength(maximum)), "");
const nonNegativeNumber = v.pipe(v.number(), v.finite(), v.minValue(0));
const optionalEmail = v.optional(
  v.union([v.literal(""), v.pipe(v.string(), v.trim(), v.email(), v.maxLength(160))]),
  "",
);
const availableQuantity = v.optional(
  v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  null,
);
const httpsUrl = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(1_000),
  v.regex(/^https:\/\//i, "Use a public HTTPS media link"),
);
const variantId = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(80),
  v.regex(/^[A-Za-z0-9_-]+$/),
);

const productVariantSchema = v.object({
  variantId: v.optional(variantId),
  name: requiredText(120),
  sku: optionalText(80),
  attributes: v.optional(
    v.pipe(v.array(v.object({ name: requiredText(40), value: requiredText(80) })), v.maxLength(5)),
    [],
  ),
  price: nonNegativeNumber,
  availableQuantity,
  isAvailable: v.optional(v.boolean(), true),
});

export const catalogProductSchema = v.pipe(
  v.object({
    name: requiredText(120),
    description: optionalText(2_000),
    category: optionalText(80),
    productType: v.optional(
      v.picklist(["CLOTHING", "FARM_PRODUCT", "MERCHANDISE", "OTHER"]),
      "OTHER",
    ),
    mediaUrls: v.optional(
      v.pipe(
        v.array(httpsUrl),
        v.maxLength(8),
        v.check((items) => new Set(items).size === items.length, "Use each media link once"),
      ),
      [],
    ),
    basePrice: nonNegativeNumber,
    availableQuantity,
    variants: v.optional(v.pipe(v.array(productVariantSchema), v.maxLength(30)), []),
    isFeatured: v.optional(v.boolean(), false),
    isOrderable: v.optional(v.boolean(), true),
    isActive: v.optional(v.boolean(), true),
  }),
  v.check(
    (product) =>
      product.variants.length === 0 ||
      new Set(product.variants.map((variant) => variant.variantId).filter(Boolean)).size ===
        product.variants.filter((variant) => variant.variantId).length,
    "Use a unique id for every product variant",
  ),
);

const orderLineSchema = v.object({
  sourceType: v.picklist(["MENU_ITEM", "PRODUCT"]),
  sourceId: requiredText(80),
  variantId: v.optional(v.nullable(variantId), null),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(99)),
});

export const publicOrderSchema = v.pipe(
  v.object({
    idempotencyKey: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(16),
      v.maxLength(100),
      v.regex(/^[A-Za-z0-9_-]+$/),
    ),
    customer: v.object({
      name: requiredText(120),
      phone: requiredText(40),
      email: optionalEmail,
    }),
    fulfillmentMethod: v.picklist(["PICKUP", "DELIVERY"]),
    deliveryAddress: optionalText(500),
    paymentMethod: v.picklist(["PAY_ON_PICKUP", "CASH_ON_DELIVERY"]),
    items: v.pipe(v.array(orderLineSchema), v.minLength(1), v.maxLength(30)),
    customerNotes: optionalText(1_000),
  }),
  v.check(
    (order) => order.fulfillmentMethod !== "DELIVERY" || order.deliveryAddress.length >= 5,
    "Enter the delivery address",
  ),
  v.check(
    (order) => order.fulfillmentMethod === "DELIVERY" || order.paymentMethod === "PAY_ON_PICKUP",
    "Pickup orders must be paid on pickup",
  ),
  v.check(
    (order) => order.fulfillmentMethod === "PICKUP" || order.paymentMethod === "CASH_ON_DELIVERY",
    "Delivery orders must use cash on delivery",
  ),
);

export const orderStatusSchema = v.object({
  status: v.picklist(["CONFIRMED", "PROCESSING", "READY", "COMPLETED", "CANCELLED"]),
  note: optionalText(500),
  cancellationReason: optionalText(500),
});

export type CatalogProductInput = v.InferOutput<typeof catalogProductSchema>;
export type PublicOrderInput = v.InferOutput<typeof publicOrderSchema>;
