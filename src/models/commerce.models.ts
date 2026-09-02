import mongoose from "mongoose";
import { createModel, money, objectId, optionalMoney, schemaOptions } from "./helpers.js";

const { Schema } = mongoose;

const productAttributeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    value: { type: String, required: true, trim: true, maxlength: 80 },
  },
  { _id: false },
);

const productVariantSchema = new Schema(
  {
    variantId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    sku: { type: String, default: "", trim: true, maxlength: 80 },
    attributes: { type: [productAttributeSchema], default: [] },
    price: money,
    availableQuantity: { type: Number, default: null, min: 0 },
    isAvailable: { type: Boolean, default: true },
  },
  { _id: false },
);

const catalogProductSchema = new Schema(
  {
    businessId: objectId("Business", true),
    productCode: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", trim: true, maxlength: 2_000 },
    category: { type: String, default: "", trim: true, maxlength: 80 },
    productType: {
      type: String,
      enum: ["CLOTHING", "FARM_PRODUCT", "MERCHANDISE", "OTHER"],
      default: "OTHER",
    },
    mediaUrls: { type: [String], default: [] },
    basePrice: money,
    availableQuantity: { type: Number, default: null, min: 0 },
    variants: { type: [productVariantSchema], default: [] },
    isFeatured: { type: Boolean, default: false },
    isOrderable: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  schemaOptions,
);
catalogProductSchema.index({ businessId: 1, productCode: 1 }, { unique: true });
catalogProductSchema.index({ businessId: 1, isActive: 1, name: 1 });

const catalogDiscountSchema = new Schema(
  {
    businessId: objectId("Business", true),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: ["PERCENTAGE", "FIXED"], required: true },
    value: { type: Number, required: true, min: 0 },
    productIds: { type: [Schema.Types.ObjectId], ref: "CatalogProduct", required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    isEnabled: { type: Boolean, default: true },
  },
  schemaOptions,
);
// A single promotion document makes bulk changes atomic. This index also blocks
// concurrent requests assigning different enabled promotions to the same product.
catalogDiscountSchema.index(
  { businessId: 1, productIds: 1 },
  { unique: true, partialFilterExpression: { isEnabled: true } },
);
catalogDiscountSchema.index({ businessId: 1, endsAt: 1 });

const orderItemSchema = new Schema(
  {
    sourceType: { type: String, enum: ["MENU_ITEM", "PRODUCT"], required: true },
    sourceId: objectId(undefined, true),
    variantId: { type: String, default: null },
    nameSnapshot: { type: String, required: true },
    categorySnapshot: { type: String, default: "" },
    variantSnapshot: { type: String, default: "" },
    mediaUrlSnapshot: { type: String, default: "" },
    unitPrice: money,
    originalUnitPrice: optionalMoney,
    discountAmount: optionalMoney,
    discountSnapshot: {
      type: new Schema(
        {
          promotionId: objectId("CatalogDiscount"),
          name: String,
          type: String,
          value: Number,
        },
        { _id: false },
      ),
      default: null,
    },
    quantity: { type: Number, required: true, min: 1, max: 99 },
    lineTotal: money,
  },
  { _id: false },
);

const orderStatusHistorySchema = new Schema(
  {
    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "PROCESSING", "READY", "COMPLETED", "CANCELLED"],
      required: true,
    },
    changedAt: { type: Date, required: true },
    changedByUserId: objectId("User"),
    note: { type: String, default: "", trim: true, maxlength: 500 },
  },
  { _id: false },
);

const customerOrderSchema = new Schema(
  {
    businessId: objectId("Business", true),
    landingPageId: objectId("LandingPage", true),
    orderNumber: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    sourceSlugSnapshot: { type: String, required: true },
    customer: {
      name: { type: String, required: true, trim: true, maxlength: 120 },
      phone: { type: String, required: true, trim: true, maxlength: 40 },
      email: { type: String, default: "", trim: true, lowercase: true, maxlength: 160 },
    },
    fulfillmentMethod: { type: String, enum: ["PICKUP", "DELIVERY"], required: true },
    deliveryAddress: { type: String, default: "", trim: true, maxlength: 500 },
    paymentMethod: {
      type: String,
      enum: ["PAY_ON_PICKUP", "CASH_ON_DELIVERY"],
      required: true,
    },
    items: { type: [orderItemSchema], required: true },
    subtotal: money,
    deliveryFee: optionalMoney,
    total: money,
    customerNotes: { type: String, default: "", trim: true, maxlength: 1_000 },
    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "PROCESSING", "READY", "COMPLETED", "CANCELLED"],
      default: "PENDING",
    },
    statusHistory: { type: [orderStatusHistorySchema], default: [] },
    cancellationReason: { type: String, default: "", trim: true, maxlength: 500 },
    stockReserved: { type: Boolean, default: false },
    transitionLock: { type: String, default: null, select: false },
    confirmedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  schemaOptions,
);
customerOrderSchema.index({ businessId: 1, orderNumber: 1 }, { unique: true });
customerOrderSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
customerOrderSchema.index({ businessId: 1, status: 1, createdAt: -1 });
customerOrderSchema.index({ businessId: 1, "customer.phone": 1, createdAt: -1 });

export const CatalogProduct = createModel("CatalogProduct", catalogProductSchema);
export const CatalogDiscount = createModel("CatalogDiscount", catalogDiscountSchema);
export const CustomerOrder = createModel("CustomerOrder", customerOrderSchema);
