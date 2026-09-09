import mongoose from "mongoose";
import { createModel, money, objectId, schemaOptions } from "./helpers.js";

const { Schema } = mongoose;

const recipeSchema = new Schema(
  {
    businessId: objectId("Business", true),
    recipeCode: { type: String, required: true },
    name: { type: String, required: true },
    yieldServings: money,
    ingredients: [
      {
        inventoryItemId: objectId("InventoryItem", true),
        itemNameSnapshot: String,
        quantity: money,
        unit: String,
        expectedWastePercent: money,
      },
    ],
    preparationCosts: [{ name: String, amount: money }],
    estimatedIngredientCostCached: money,
    estimatedPreparationCostCached: money,
    estimatedBatchCostCached: money,
    estimatedCostPerServingCached: money,
    version: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },
  },
  schemaOptions,
);
recipeSchema.index({ businessId: 1, recipeCode: 1 }, { unique: true });

const menuItemSchema = new Schema(
  {
    businessId: objectId("Business", true),
    menuCode: { type: String, required: true },
    name: { type: String, required: true },
    category: String,
    mediaUrls: [String],
    googleDriveUrl: String,
    googleDriveUrls: [String],
    recipeId: objectId("Recipe", true),
    sellingPricePerServing: money,
    targetFoodCostPercent: money,
    calculatedCostPerServingCached: money,
    calculatedProfitPerServingCached: money,
    calculatedFoodCostPercentCached: money,
    suggestedSellingPriceCached: money,
    isAvailable: { type: Boolean, default: true },
    showOnLandingPage: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  schemaOptions,
);
menuItemSchema.index({ businessId: 1, menuCode: 1 }, { unique: true });

const cookingBatchSchema = new Schema(
  {
    businessId: objectId("Business", true),
    cookingBatchNumber: { type: String, required: true },
    cookingDate: { type: Date, required: true },
    menuItemId: objectId("MenuItem", true),
    recipeId: objectId("Recipe", true),
    recipeVersion: Number,
    plannedServings: money,
    actualServingsProduced: money,
    ingredientUsages: [
      {
        inventoryItemId: objectId("InventoryItem", true),
        inventoryLotId: objectId("InventoryLot"),
        quantityUsed: money,
        unit: String,
        unitCostSnapshot: money,
        totalCost: money,
        inventoryMovementId: objectId("InventoryMovement"),
      },
    ],
    additionalCosts: [{ name: String, amount: money }],
    totalIngredientCost: money,
    totalAdditionalCost: money,
    totalBatchCost: money,
    costPerServing: money,
    servingsSoldCached: money,
    servingsComplimentary: money,
    servingsWasted: money,
    servingsRemainingCached: money,
    notes: String,
    status: { type: String, enum: ["DRAFT", "COMPLETED", "CLOSED", "VOIDED"], default: "DRAFT" },
  },
  schemaOptions,
);
cookingBatchSchema.index({ businessId: 1, cookingBatchNumber: 1 }, { unique: true });

const karenderiyaSaleSchema = new Schema(
  {
    businessId: objectId("Business", true),
    salesNumber: { type: String, required: true },
    salesDate: { type: Date, required: true },
    items: [
      {
        menuItemId: objectId("MenuItem", true),
        menuNameSnapshot: String,
        quantitySold: money,
        sellingPricePerServing: money,
        grossAmount: money,
        discount: money,
        netAmount: money,
        costPerServingSnapshot: money,
        totalCost: money,
        grossProfit: money,
        cookingBatchAllocations: [{ cookingBatchId: objectId("CookingBatch"), quantity: money }],
      },
    ],
    grossSales: money,
    discountTotal: money,
    netSales: money,
    costOfFoodSold: money,
    grossProfit: money,
    ingredientUsages: [
      {
        inventoryItemId: objectId("InventoryItem", true),
        itemNameSnapshot: String,
        quantityUsed: money,
        unit: String,
        unitCostSnapshot: money,
        totalCost: money,
        inventoryMovementId: objectId("InventoryMovement"),
      },
    ],
    amountReceived: money,
    receivingAccountId: objectId("CashAccount"),
    cashTransactionId: objectId("CashTransaction"),
    notes: String,
    status: { type: String, enum: ["DRAFT", "POSTED", "VOIDED"], default: "POSTED" },
  },
  schemaOptions,
);
karenderiyaSaleSchema.index({ businessId: 1, salesNumber: 1 }, { unique: true });
karenderiyaSaleSchema.index({ businessId: 1, salesDate: -1 });

export const Recipe = createModel("Recipe", recipeSchema);
export const MenuItem = createModel("MenuItem", menuItemSchema);
export const CookingBatch = createModel("CookingBatch", cookingBatchSchema);
export const KarenderiyaSale = createModel("KarenderiyaSale", karenderiyaSaleSchema);
