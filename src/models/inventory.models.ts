import mongoose from "mongoose";
import { createModel, money, objectId, optionalMoney, schemaOptions } from "./helpers.js";

const { Schema } = mongoose;

const inventoryItemSchema = new Schema(
  {
    businessId: objectId("Business", true),
    itemCode: { type: String, required: true },
    name: { type: String, required: true },
    businessUnit: { type: String, enum: ["PIGGERY", "KARENDERIYA", "SHARED"], required: true },
    category: {
      type: String,
      enum: [
        "FEED",
        "MEAT",
        "BYPRODUCT",
        "INGREDIENT",
        "MEDICINE",
        "PACKAGING",
        "FUEL",
        "SUPPLY",
        "OTHER",
      ],
      required: true,
    },
    baseUnit: {
      type: String,
      enum: ["KG", "GRAM", "LITER", "ML", "PIECE", "PACK", "SACK", "BOTTLE", "OTHER"],
      required: true,
    },
    purchaseUnit: String,
    purchaseUnitToBaseUnit: optionalMoney,
    lowStockLevel: optionalMoney,
    defaultExternalPricePerUnit: optionalMoney,
    defaultKarenderiyaTransferPricePerUnit: optionalMoney,
    currentStockCached: money,
    isPerishable: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  schemaOptions,
);
inventoryItemSchema.index({ businessId: 1, itemCode: 1 }, { unique: true });

const inventoryLotSchema = new Schema(
  {
    businessId: objectId("Business", true),
    itemId: objectId("InventoryItem", true),
    lotCode: { type: String, required: true },
    parentLotId: objectId("InventoryLot"),
    sourceType: {
      type: String,
      enum: ["PURCHASE", "SLAUGHTER", "INTERNAL_TRANSFER", "ADJUSTMENT"],
      required: true,
    },
    sourceDocumentId: objectId(),
    businessUnit: { type: String, enum: ["PIGGERY", "KARENDERIYA"], required: true },
    storageLocation: String,
    receivedDate: { type: Date, required: true },
    expiryDate: Date,
    purchaseQuantity: optionalMoney,
    purchaseUnit: String,
    purchaseUnitToBaseUnit: optionalMoney,
    initialQuantity: money,
    remainingQuantityCached: money,
    unitCost: money,
    totalCost: money,
    status: { type: String, enum: ["ACTIVE", "DEPLETED", "EXPIRED", "VOIDED"], default: "ACTIVE" },
  },
  schemaOptions,
);
inventoryLotSchema.index({ businessId: 1, itemId: 1, lotCode: 1 }, { unique: true });

const inventoryMovementSchema = new Schema(
  {
    businessId: objectId("Business", true),
    movementNumber: { type: String, required: true },
    movementDate: { type: Date, required: true },
    movementType: {
      type: String,
      enum: [
        "RECEIPT",
        "PRODUCTION",
        "CONSUMPTION",
        "TRANSFER",
        "SALE",
        "WASTE",
        "SPOILAGE",
        "ADJUSTMENT_IN",
        "ADJUSTMENT_OUT",
      ],
      required: true,
    },
    itemId: objectId("InventoryItem", true),
    fromBusinessUnit: { type: String, enum: ["PIGGERY", "KARENDERIYA", "EXTERNAL", null] },
    toBusinessUnit: { type: String, enum: ["PIGGERY", "KARENDERIYA", "EXTERNAL", null] },
    fromLotId: objectId("InventoryLot"),
    toLotId: objectId("InventoryLot"),
    quantity: money,
    unit: String,
    unitCostSnapshot: money,
    totalCost: money,
    allocations: [
      {
        targetType: {
          type: String,
          enum: ["PIG", "PIG_BATCH", "SLAUGHTER", "COOKING_BATCH", "GENERAL"],
        },
        targetId: objectId(),
        quantity: money,
        allocatedCost: money,
      },
    ],
    source: { collection: String, documentId: objectId() },
    reason: String,
    status: { type: String, enum: ["POSTED", "VOIDED"], default: "POSTED" },
  },
  schemaOptions,
);
inventoryMovementSchema.index({ businessId: 1, movementNumber: 1 }, { unique: true });
inventoryMovementSchema.index({ businessId: 1, itemId: 1, movementDate: -1 });

export const InventoryItem = createModel("InventoryItem", inventoryItemSchema);
export const InventoryLot = createModel("InventoryLot", inventoryLotSchema);
export const InventoryMovement = createModel("InventoryMovement", inventoryMovementSchema);
