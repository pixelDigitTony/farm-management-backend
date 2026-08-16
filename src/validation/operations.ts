import * as v from "valibot";
import { coercedDate, coercedNumber } from "./helpers.js";

const amount = coercedNumber(0);
const businessUnit = v.picklist(["PIGGERY", "KARENDERIYA", "GENERAL"]);
const description = v.pipe(v.string(), v.trim(), v.minLength(2));

export const expenseOperationSchema = v.object({
  expenseNumber: v.pipe(v.string(), v.minLength(1)),
  expenseDate: coercedDate,
  businessUnit,
  category: v.picklist([
    "PIG_PURCHASE",
    "FEED",
    "MEDICINE",
    "VETERINARY",
    "SLAUGHTER",
    "TRANSPORT",
    "INGREDIENT",
    "FUEL",
    "UTILITIES",
    "PACKAGING",
    "REPAIR",
    "SUPPLY",
    "RENT",
    "OTHER",
  ]),
  description,
  totalAmount: amount,
  amountPaid: v.optional(amount, 0),
  accountId: v.optional(v.string()),
});

export const cashOperationSchema = v.object({
  transactionDate: coercedDate,
  businessUnit,
  transactionType: v.picklist(["CASH_IN", "CASH_OUT", "TRANSFER", "ADJUSTMENT"]),
  category: v.picklist([
    "SALE_COLLECTION",
    "EXPENSE_PAYMENT",
    "OWNER_CAPITAL",
    "OWNER_WITHDRAWAL",
    "ACCOUNT_TRANSFER",
    "REFUND",
    "OTHER",
  ]),
  amount: coercedNumber(0, false),
  accountId: v.optional(v.string()),
  fromAccountId: v.optional(v.string()),
  toAccountId: v.optional(v.string()),
  description,
});

export const karenderiyaSaleOperationSchema = v.object({
  salesDate: coercedDate,
  receivingAccountId: v.string(),
  items: v.pipe(
    v.array(
      v.object({
        menuItemId: v.string(),
        cookingBatchId: v.optional(v.string()),
        quantitySold: coercedNumber(0, false),
        discount: v.optional(amount, 0),
      }),
    ),
    v.minLength(1),
  ),
  notes: v.optional(v.string()),
});

export const karenderiyaSaleUpdateSchema = v.object({
  salesDate: coercedDate,
  notes: v.optional(v.string()),
});

export const inventoryReceiptOperationSchema = v.object({
  movementDate: coercedDate,
  itemId: v.string(),
  quantity: coercedNumber(0, false),
  unitCost: amount,
  businessUnit: v.picklist(["PIGGERY", "KARENDERIYA"]),
  storageLocation: v.optional(v.string()),
  expiryDate: v.optional(coercedDate),
  supplierId: v.optional(v.string()),
  amountPaid: v.optional(amount, 0),
  accountId: v.optional(v.string()),
  notes: v.optional(v.string()),
});

export const feedUsageOperationSchema = v.object({
  usageDate: coercedDate,
  feedItemId: v.string(),
  inventoryLotId: v.optional(v.string()),
  allocationType: v.picklist(["PIG", "PIG_BATCH", "GENERAL"]),
  pigId: v.optional(v.string()),
  batchId: v.optional(v.string()),
  quantityUsed: coercedNumber(0, false),
  notes: v.optional(v.string()),
});

export const pigMeasurementOperationSchema = v.object({
  measurementDate: coercedDate,
  pigId: v.string(),
  weightKg: coercedNumber(0, false),
  notes: v.optional(v.string()),
});

export const pigAcquisitionOperationSchema = v.object({
  pigCode: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  earTag: v.optional(v.string()),
  batchId: v.optional(v.string()),
  sex: v.picklist(["MALE", "FEMALE", "UNKNOWN"]),
  breed: v.optional(v.string()),
  acquisitionDate: coercedDate,
  purchaseCost: amount,
  currentPen: v.optional(v.string()),
  latestWeightKgCached: v.optional(coercedNumber(0, false)),
  amountPaid: v.optional(amount, 0),
  accountId: v.optional(v.string()),
  notes: v.optional(v.string()),
});

export const slaughterOperationSchema = v.object({
  pigId: v.string(),
  slaughterDate: coercedDate,
  liveWeightKg: coercedNumber(0, false),
  carcassWeightKg: coercedNumber(0, false),
  costs: v.array(v.object({ name: v.pipe(v.string(), v.minLength(1)), amount })),
  parts: v.pipe(
    v.array(
      v.object({
        name: v.pipe(v.string(), v.minLength(1)),
        classification: v.picklist(["MEAT", "BYPRODUCT", "WASTE"]),
        weightKg: amount,
        externalPricePerKg: v.optional(amount, 0),
        karenderiyaTransferPricePerKg: v.optional(amount, 0),
      }),
    ),
    v.minLength(1),
  ),
  amountPaid: v.optional(amount, 0),
  accountId: v.optional(v.string()),
  notes: v.optional(v.string()),
});

export const meatTransferOperationSchema = v.object({
  movementDate: coercedDate,
  inventoryItemId: v.string(),
  sourceLotId: v.string(),
  quantity: coercedNumber(0, false),
  transferPricePerKg: v.optional(amount),
  storageLocation: v.optional(v.string()),
  notes: v.optional(v.string()),
});

export const piggerySaleOperationSchema = v.object({
  saleDate: coercedDate,
  buyerId: v.optional(v.string()),
  saleType: v.picklist(["LIVE_PIG", "MEAT_PART", "BYPRODUCT"]),
  pigId: v.optional(v.string()),
  inventoryItemId: v.optional(v.string()),
  inventoryLotId: v.optional(v.string()),
  description: v.pipe(v.string(), v.minLength(1)),
  headCount: v.optional(coercedNumber(0, false)),
  weightKg: v.optional(coercedNumber(0, false)),
  priceBasis: v.picklist(["PER_HEAD", "PER_KG"]),
  price: coercedNumber(0, false),
  amountReceived: v.optional(amount, 0),
  receivingAccountId: v.optional(v.string()),
  notes: v.optional(v.string()),
});

export const cookingBatchOperationSchema = v.object({
  cookingDate: coercedDate,
  menuItemId: v.string(),
  actualServingsProduced: coercedNumber(0, false),
  additionalCosts: v.optional(
    v.array(v.object({ name: v.pipe(v.string(), v.minLength(1)), amount })),
    [],
  ),
  notes: v.optional(v.string()),
});

const recipeIngredientSchema = v.object({
  inventoryItemId: v.string(),
  itemNameSnapshot: v.optional(v.string()),
  quantity: coercedNumber(0, false),
  unit: v.optional(v.string()),
  expectedWastePercent: v.optional(amount, 0),
});

export const menuRecipeOperationSchema = v.object({
  recipe: v.object({
    recipeCode: v.pipe(v.string(), v.trim(), v.minLength(1)),
    name: v.pipe(v.string(), v.trim(), v.minLength(1)),
    yieldServings: coercedNumber(0, false),
    ingredients: v.pipe(v.array(recipeIngredientSchema), v.minLength(1)),
    preparationCosts: v.optional(
      v.array(v.object({ name: v.pipe(v.string(), v.trim(), v.minLength(1)), amount })),
      [],
    ),
    estimatedIngredientCostCached: amount,
    estimatedPreparationCostCached: amount,
    estimatedBatchCostCached: amount,
    estimatedCostPerServingCached: amount,
  }),
  menu: v.object({
    menuCode: v.pipe(v.string(), v.trim(), v.minLength(1)),
    name: v.pipe(v.string(), v.trim(), v.minLength(1)),
    category: v.optional(v.string()),
    sellingPricePerServing: amount,
    targetFoodCostPercent: coercedNumber(0, false),
    calculatedCostPerServingCached: amount,
    calculatedProfitPerServingCached: v.pipe(v.unknown(), v.toNumber(), v.number()),
    calculatedFoodCostPercentCached: amount,
    suggestedSellingPriceCached: amount,
    isAvailable: v.optional(v.boolean(), true),
  }),
});
