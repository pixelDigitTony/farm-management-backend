import mongoose from "mongoose";
import { createModel, money, objectId, schemaOptions } from "./helpers.js";

const { Schema } = mongoose;

const attachment = new Schema(
  {
    fileName: String,
    fileUrl: String,
    mimeType: String,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const cashAccountSchema = new Schema(
  {
    businessId: objectId("Business", true),
    accountCode: { type: String, required: true },
    name: { type: String, required: true },
    accountType: { type: String, enum: ["CASH", "BANK", "EWALLET"], required: true },
    provider: String,
    maskedAccountNumber: String,
    openingBalance: money,
    openingBalanceDate: { type: Date, default: Date.now },
    currentBalanceCached: money,
    isActive: { type: Boolean, default: true },
  },
  schemaOptions,
);
cashAccountSchema.index({ businessId: 1, accountCode: 1 }, { unique: true });

const cashTransactionSchema = new Schema(
  {
    businessId: objectId("Business", true),
    transactionNumber: { type: String, required: true },
    transactionDate: { type: Date, required: true },
    businessUnit: { type: String, enum: ["PIGGERY", "KARENDERIYA", "GENERAL"], required: true },
    transactionType: {
      type: String,
      enum: ["OPENING_BALANCE", "CASH_IN", "CASH_OUT", "TRANSFER", "ADJUSTMENT"],
      required: true,
    },
    category: {
      type: String,
      enum: [
        "SALE_COLLECTION",
        "EXPENSE_PAYMENT",
        "OWNER_CAPITAL",
        "OWNER_WITHDRAWAL",
        "ACCOUNT_TRANSFER",
        "REFUND",
        "DEBIT",
        "OTHER",
      ],
      required: true,
    },
    accountId: objectId("CashAccount"),
    fromAccountId: objectId("CashAccount"),
    toAccountId: objectId("CashAccount"),
    contactId: objectId("Contact"),
    amount: { ...money, required: true },
    source: { collection: String, documentId: objectId() },
    description: { type: String, required: true },
    attachments: [attachment],
    status: { type: String, enum: ["POSTED", "VOIDED"], default: "POSTED" },
    voidReason: String,
    voidedAt: Date,
  },
  schemaOptions,
);
cashTransactionSchema.index({ businessId: 1, transactionNumber: 1 }, { unique: true });
cashTransactionSchema.index({ businessId: 1, transactionDate: -1 });

const expenseItem = new Schema(
  {
    description: { type: String, required: true },
    inventoryItemId: objectId("InventoryItem"),
    quantity: money,
    unit: String,
    unitPrice: money,
    lineTotal: money,
    costTreatment: {
      type: String,
      enum: ["INVENTORY", "DIRECT_PIG_COST", "GENERAL_EXPENSE"],
      default: "GENERAL_EXPENSE",
    },
  },
  { _id: false },
);
const allocation = new Schema(
  {
    targetType: {
      type: String,
      enum: ["PIG", "PIG_BATCH", "SLAUGHTER", "COOKING_BATCH", "GENERAL"],
    },
    targetId: objectId(),
    allocationMethod: { type: String, enum: ["AMOUNT", "PERCENTAGE"] },
    value: money,
    allocatedAmount: money,
  },
  { _id: false },
);
const expenseSchema = new Schema(
  {
    businessId: objectId("Business", true),
    expenseNumber: { type: String, required: true },
    businessUnit: { type: String, enum: ["PIGGERY", "KARENDERIYA", "GENERAL"], required: true },
    expenseDate: { type: Date, required: true },
    dueDate: Date,
    supplierId: objectId("Contact"),
    category: {
      type: String,
      enum: [
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
        "LIABILITY",
        "OTHER",
      ],
      required: true,
    },
    description: { type: String, required: true },
    items: [expenseItem],
    subtotal: money,
    additionalCharges: money,
    totalAmount: money,
    amountPaidCached: money,
    paymentAccountIdCached: objectId("CashAccount"),
    balanceDueCached: money,
    paymentStatus: { type: String, enum: ["UNPAID", "PARTIALLY_PAID", "PAID"], default: "UNPAID" },
    allocations: [allocation],
    attachments: [attachment],
    status: { type: String, enum: ["DRAFT", "POSTED", "VOIDED"], default: "POSTED" },
    voidReason: String,
  },
  schemaOptions,
);
expenseSchema.index({ businessId: 1, expenseNumber: 1 }, { unique: true });
expenseSchema.index({ businessId: 1, businessUnit: 1, expenseDate: -1 });

export const CashAccount = createModel("CashAccount", cashAccountSchema);
export const CashTransaction = createModel("CashTransaction", cashTransactionSchema);
export const Expense = createModel("Expense", expenseSchema);
