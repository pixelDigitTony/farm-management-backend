import mongoose from "mongoose";
import { createModel, money, objectId, optionalMoney, schemaOptions } from "./helpers.js";

const { Schema } = mongoose;

const pigBatchSchema = new Schema(
  {
    businessId: objectId("Business", true),
    batchCode: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    purpose: { type: String, enum: ["FATTENING", "BREEDING", "MIXED"], default: "FATTENING" },
    sourceContactId: objectId("Contact"),
    arrivalDate: Date,
    initialHeadCount: { type: Number, min: 0 },
    activeHeadCountCached: { type: Number, min: 0 },
    currentPen: String,
    status: { type: String, enum: ["ACTIVE", "COMPLETED", "CANCELLED"], default: "ACTIVE" },
    notes: String,
  },
  schemaOptions,
);
pigBatchSchema.index({ businessId: 1, batchCode: 1 }, { unique: true });

const pigSchema = new Schema(
  {
    businessId: objectId("Business", true),
    pigCode: { type: String, required: true },
    earTag: String,
    batchId: objectId("PigBatch"),
    photoUrl: String,
    sex: { type: String, enum: ["MALE", "FEMALE", "UNKNOWN"], default: "UNKNOWN" },
    breed: String,
    birthDate: Date,
    acquisitionDate: Date,
    sourceContactId: objectId("Contact"),
    purchaseCost: money,
    currentPen: String,
    latestWeightKgCached: optionalMoney,
    accumulatedCostCached: money,
    status: {
      type: String,
      enum: ["ACTIVE", "SOLD", "SLAUGHTERED", "DEAD", "CULLED", "TRANSFERRED"],
      default: "ACTIVE",
    },
    statusDate: Date,
    statusReason: String,
    notes: String,
  },
  schemaOptions,
);
pigSchema.index({ businessId: 1, pigCode: 1 }, { unique: true });
pigSchema.index({ businessId: 1, status: 1 });

const pigMeasurementSchema = new Schema(
  {
    businessId: objectId("Business", true),
    measurementDate: { type: Date, required: true },
    measurementType: {
      type: String,
      enum: ["INDIVIDUAL", "BATCH_AVERAGE", "BATCH_TOTAL"],
      required: true,
    },
    pigId: objectId("Pig"),
    batchId: objectId("PigBatch"),
    headCount: Number,
    weightKg: optionalMoney,
    averageWeightKg: optionalMoney,
    totalWeightKg: optionalMoney,
    notes: String,
  },
  schemaOptions,
);
pigMeasurementSchema.index({ businessId: 1, measurementDate: -1 });

const feedUsageSchema = new Schema(
  {
    businessId: objectId("Business", true),
    usageNumber: { type: String, required: true },
    usageDate: { type: Date, required: true },
    feedItemId: objectId("InventoryItem", true),
    inventoryLotId: objectId("InventoryLot"),
    allocationType: { type: String, enum: ["PIG", "PIG_BATCH", "GENERAL"], required: true },
    pigId: objectId("Pig"),
    batchId: objectId("PigBatch"),
    headCount: Number,
    quantityUsed: { ...money, required: true },
    unit: { type: String, default: "KG" },
    unitCostSnapshot: money,
    totalFeedCost: money,
    costPerPig: optionalMoney,
    inventoryMovementId: objectId("InventoryMovement"),
    notes: String,
    status: { type: String, enum: ["DRAFT", "POSTED", "VOIDED"], default: "POSTED" },
    voidReason: String,
  },
  schemaOptions,
);
feedUsageSchema.index({ businessId: 1, usageNumber: 1 }, { unique: true });

const slaughterSettingSchema = new Schema(
  {
    businessId: objectId("Business", true),
    name: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
    costItems: [
      {
        code: String,
        name: String,
        calculationMethod: {
          type: String,
          enum: ["FLAT", "PER_LIVE_KG", "PER_CARCASS_KG", "MANUAL"],
        },
        defaultRate: money,
        isActive: { type: Boolean, default: true },
      },
    ],
    meatParts: [
      {
        code: String,
        name: String,
        classification: { type: String, enum: ["MEAT", "BYPRODUCT", "WASTE"] },
        defaultExternalPricePerKg: optionalMoney,
        defaultKarenderiyaPricePerKg: optionalMoney,
        isUsableForCooking: { type: Boolean, default: true },
        isActive: { type: Boolean, default: true },
      },
    ],
    costAllocationMethod: {
      type: String,
      enum: ["AVERAGE_USABLE_KG", "MANUAL"],
      default: "AVERAGE_USABLE_KG",
    },
  },
  schemaOptions,
);

const slaughterRecordSchema = new Schema(
  {
    businessId: objectId("Business", true),
    slaughterNumber: { type: String, required: true },
    pigId: objectId("Pig", true),
    batchId: objectId("PigBatch"),
    slaughterDate: { type: Date, required: true },
    slaughterhouseId: objectId("Contact"),
    butcherId: objectId("Contact"),
    liveWeightKg: money,
    wholeCarcassWeightKg: money,
    usablePartsWeightKg: money,
    byproductWeightKg: money,
    wasteWeightKg: money,
    unaccountedWeightKg: money,
    raisingCostAtSlaughter: money,
    costLines: [
      {
        code: String,
        name: String,
        calculationMethod: {
          type: String,
          enum: ["FLAT", "PER_LIVE_KG", "PER_CARCASS_KG", "MANUAL"],
        },
        rate: money,
        baseQuantity: money,
        amount: money,
        expenseId: objectId("Expense"),
      },
    ],
    totalSlaughterCost: money,
    totalPigAndSlaughterCost: money,
    costAllocationMethod: {
      type: String,
      enum: ["AVERAGE_USABLE_KG", "MANUAL"],
      default: "AVERAGE_USABLE_KG",
    },
    averageUsableMeatCostPerKg: money,
    dressingPercentage: money,
    usableYieldPercentage: money,
    parts: [
      {
        inventoryItemId: objectId("InventoryItem"),
        partCode: String,
        partName: String,
        classification: { type: String, enum: ["MEAT", "BYPRODUCT", "WASTE"] },
        weightKg: money,
        allocatedCost: money,
        productionCostPerKg: money,
        externalPricePerKg: optionalMoney,
        karenderiyaTransferPricePerKg: optionalMoney,
        producedLotId: objectId("InventoryLot"),
      },
    ],
    notes: String,
    status: { type: String, enum: ["DRAFT", "COMPLETED", "VOIDED"], default: "DRAFT" },
  },
  schemaOptions,
);
slaughterRecordSchema.index({ businessId: 1, slaughterNumber: 1 }, { unique: true });

const piggerySaleSchema = new Schema(
  {
    businessId: objectId("Business", true),
    saleNumber: { type: String, required: true },
    saleDate: { type: Date, required: true },
    buyerId: objectId("Contact"),
    saleType: {
      type: String,
      enum: ["LIVE_PIG", "WHOLE_CARCASS", "MEAT_PART", "BYPRODUCT"],
      required: true,
    },
    items: [
      {
        sourceType: { type: String, enum: ["PIG", "MEAT_LOT"] },
        pigId: objectId("Pig"),
        inventoryItemId: objectId("InventoryItem"),
        inventoryLotId: objectId("InventoryLot"),
        description: String,
        headCount: Number,
        weightKg: optionalMoney,
        priceBasis: { type: String, enum: ["PER_HEAD", "PER_KG"] },
        price: money,
        grossAmount: money,
        costSnapshot: money,
        grossProfit: money,
      },
    ],
    subtotal: money,
    discount: money,
    totalAmount: money,
    amountReceivedCached: money,
    balanceDueCached: money,
    receivingAccountId: objectId("CashAccount"),
    cashTransactionId: objectId("CashTransaction"),
    paymentStatus: { type: String, enum: ["UNPAID", "PARTIALLY_PAID", "PAID"], default: "UNPAID" },
    notes: String,
    status: { type: String, enum: ["DRAFT", "POSTED", "VOIDED"], default: "POSTED" },
  },
  schemaOptions,
);
piggerySaleSchema.index({ businessId: 1, saleNumber: 1 }, { unique: true });

export const PigBatch = createModel("PigBatch", pigBatchSchema);
export const Pig = createModel("Pig", pigSchema);
export const PigMeasurement = createModel("PigMeasurement", pigMeasurementSchema);
export const FeedUsageRecord = createModel("FeedUsageRecord", feedUsageSchema);
export const SlaughterSetting = createModel("SlaughterSetting", slaughterSettingSchema);
export const SlaughterRecord = createModel("SlaughterRecord", slaughterRecordSchema);
export const PiggerySale = createModel("PiggerySale", piggerySaleSchema);
