import type { Types } from "mongoose";
import type { InferOutput } from "valibot";
import { decimal, moneyString } from "../lib/decimal.js";
import { HttpError } from "../lib/http-error.js";
import { inTransaction } from "../lib/transaction.js";
import {
  CashAccount,
  CashTransaction,
  CookingBatch,
  Expense,
  InventoryItem,
  InventoryMovement,
  KarenderiyaSale,
  MenuItem,
  Recipe,
} from "../models/index.js";
import type {
  cashOperationSchema,
  expenseOperationSchema,
  karenderiyaSaleOperationSchema,
} from "../validation/operations.js";
import { calculateRecipeIngredientUsage } from "./calculation.service.js";

type CashInput = InferOutput<typeof cashOperationSchema>;

async function postCashInTransaction(
  businessId: Types.ObjectId,
  input: CashInput,
  source?: { collection: string; documentId: Types.ObjectId },
) {
  const accountIds =
    input.transactionType === "TRANSFER"
      ? [input.fromAccountId, input.toAccountId].filter((id): id is string => Boolean(id))
      : input.accountId
        ? [input.accountId]
        : [];
  if (input.transactionType === "TRANSFER") {
    if (!input.fromAccountId || !input.toAccountId || input.fromAccountId === input.toAccountId)
      throw new HttpError(422, "A transfer requires two different accounts");
  } else if (!input.accountId) throw new HttpError(422, "A cash account is required");
  const validAccounts = await CashAccount.countDocuments({
    _id: { $in: accountIds },
    businessId,
    isActive: true,
  });
  if (validAccounts !== accountIds.length)
    throw new HttpError(422, "One or more cash accounts were not found");

  const number = `CASH-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const transaction = await CashTransaction.create({
    ...input,
    businessId,
    transactionNumber: number,
    source,
  });
  const amount = input.amount;
  if (input.transactionType === "CASH_IN") {
    const result = await CashAccount.updateOne(
      { _id: input.accountId, businessId },
      { $inc: { currentBalanceCached: amount } },
    );
    if (!result.matchedCount) {
      await transaction.deleteOne();
      throw new HttpError(422, "Cash account was not found");
    }
  }
  if (input.transactionType === "CASH_OUT") {
    const result = await CashAccount.updateOne(
      { _id: input.accountId, businessId },
      { $inc: { currentBalanceCached: -amount } },
    );
    if (!result.matchedCount) {
      await transaction.deleteOne();
      throw new HttpError(422, "Cash account was not found");
    }
  }
  if (input.transactionType === "ADJUSTMENT") {
    const result = await CashAccount.updateOne(
      { _id: input.accountId, businessId },
      { $inc: { currentBalanceCached: amount } },
    );
    if (!result.matchedCount) {
      await transaction.deleteOne();
      throw new HttpError(422, "Cash account was not found");
    }
  }
  if (input.transactionType === "TRANSFER") {
    await CashAccount.updateOne(
      { _id: input.fromAccountId, businessId },
      { $inc: { currentBalanceCached: -amount } },
    );
    await CashAccount.updateOne(
      { _id: input.toAccountId, businessId },
      { $inc: { currentBalanceCached: amount } },
    );
  }
  return transaction;
}

async function reverseCashTransaction(businessId: Types.ObjectId, transactionId: Types.ObjectId) {
  const transaction = await CashTransaction.findOne({
    _id: transactionId,
    businessId,
    status: "POSTED",
  });
  if (!transaction) return;
  const amount = Number(transaction.amount?.toString() ?? 0);
  if (transaction.transactionType === "CASH_IN")
    await CashAccount.updateOne(
      { _id: transaction.accountId, businessId },
      { $inc: { currentBalanceCached: -amount } },
    );
  if (transaction.transactionType === "CASH_OUT")
    await CashAccount.updateOne(
      { _id: transaction.accountId, businessId },
      { $inc: { currentBalanceCached: amount } },
    );
  if (transaction.transactionType === "ADJUSTMENT")
    await CashAccount.updateOne(
      { _id: transaction.accountId, businessId },
      { $inc: { currentBalanceCached: -amount } },
    );
  if (transaction.transactionType === "TRANSFER") {
    await CashAccount.updateOne(
      { _id: transaction.fromAccountId, businessId },
      { $inc: { currentBalanceCached: amount } },
    );
    await CashAccount.updateOne(
      { _id: transaction.toAccountId, businessId },
      { $inc: { currentBalanceCached: -amount } },
    );
  }
  transaction.status = "VOIDED";
  transaction.voidReason = "Source record deleted";
  transaction.voidedAt = new Date();
  await transaction.save();
}

async function reverseExpenseCashWithoutExpenseInTransaction(
  businessId: Types.ObjectId,
  expenseId: Types.ObjectId,
) {
  const transaction = await CashTransaction.findOne({
    businessId,
    "source.collection": "expenses",
    "source.documentId": expenseId,
    status: "POSTED",
  });
  if (transaction) await reverseCashTransaction(businessId, transaction._id);
}

async function postExpenseInTransaction(
  businessId: Types.ObjectId,
  input: InferOutput<typeof expenseOperationSchema>,
) {
  if (input.amountPaid > input.totalAmount)
    throw new HttpError(422, "Amount paid cannot exceed total amount");
  if (input.amountPaid > 0 && !input.accountId)
    throw new HttpError(422, "Select the account used for payment");
  const balance = decimal(input.totalAmount).minus(input.amountPaid);
  const expense = await Expense.create({
    businessId,
    expenseNumber: input.expenseNumber,
    expenseDate: input.expenseDate,
    businessUnit: input.businessUnit,
    category: input.category,
    description: input.description,
    subtotal: input.totalAmount,
    totalAmount: input.totalAmount,
    amountPaidCached: input.amountPaid,
    paymentAccountIdCached: input.accountId,
    balanceDueCached: balance.toString(),
    paymentStatus: balance.isZero() ? "PAID" : input.amountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID",
    items: [
      {
        description: input.description,
        quantity: 1,
        unit: "ITEM",
        unitPrice: input.totalAmount,
        lineTotal: input.totalAmount,
        costTreatment: "GENERAL_EXPENSE",
      },
    ],
    status: "POSTED",
  });
  if (input.amountPaid > 0) {
    await postCash(
      businessId,
      {
        transactionDate: input.expenseDate,
        businessUnit: input.businessUnit,
        transactionType: "CASH_OUT",
        category: "EXPENSE_PAYMENT",
        amount: input.amountPaid,
        accountId: input.accountId,
        description: input.description,
      },
      { collection: "expenses", documentId: expense._id },
    );
  }
  return expense;
}

async function updateExpenseInTransaction(
  businessId: Types.ObjectId,
  expenseId: string,
  input: InferOutput<typeof expenseOperationSchema>,
) {
  const expense = await Expense.findOne({ _id: expenseId, businessId, status: "POSTED" });
  if (!expense) throw new HttpError(404, "Expense was not found");
  if (input.amountPaid > input.totalAmount)
    throw new HttpError(422, "Amount paid cannot exceed total amount");
  if (input.amountPaid > 0 && !input.accountId)
    throw new HttpError(422, "Select the account used for payment");
  if (input.amountPaid > 0 && !(await CashAccount.exists({ _id: input.accountId, businessId })))
    throw new HttpError(422, "Cash account was not found");

  const previousTransaction = await CashTransaction.findOne({
    businessId,
    "source.collection": "expenses",
    "source.documentId": expense._id,
    status: "POSTED",
  });
  if (previousTransaction) await reverseCashTransaction(businessId, previousTransaction._id);

  const balance = decimal(input.totalAmount).minus(input.amountPaid);
  expense.set({
    expenseNumber: input.expenseNumber,
    expenseDate: input.expenseDate,
    businessUnit: input.businessUnit,
    category: input.category,
    description: input.description,
    subtotal: input.totalAmount,
    totalAmount: input.totalAmount,
    amountPaidCached: input.amountPaid,
    paymentAccountIdCached: input.accountId,
    balanceDueCached: balance.toString(),
    paymentStatus: balance.isZero() ? "PAID" : input.amountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID",
    items: [
      {
        description: input.description,
        quantity: 1,
        unit: "ITEM",
        unitPrice: input.totalAmount,
        lineTotal: input.totalAmount,
        costTreatment: "GENERAL_EXPENSE",
      },
    ],
  });
  await expense.save();
  if (input.amountPaid > 0)
    await postCash(
      businessId,
      {
        transactionDate: input.expenseDate,
        businessUnit: input.businessUnit,
        transactionType: "CASH_OUT",
        category: "EXPENSE_PAYMENT",
        amount: input.amountPaid,
        accountId: input.accountId,
        description: input.description,
      },
      { collection: "expenses", documentId: expense._id },
    );
  return expense;
}

async function deleteExpenseInTransaction(businessId: Types.ObjectId, expenseId: string) {
  const expense = await Expense.findOne({ _id: expenseId, businessId });
  if (!expense) throw new HttpError(404, "Expense was not found");
  const transaction = await CashTransaction.findOne({
    businessId,
    "source.collection": "expenses",
    "source.documentId": expense._id,
    status: "POSTED",
  });
  if (transaction) await reverseCashTransaction(businessId, transaction._id);
  await expense.deleteOne();
}

async function postKarenderiyaSaleInTransaction(
  businessId: Types.ObjectId,
  input: InferOutput<typeof karenderiyaSaleOperationSchema>,
) {
  const menuIds = [...new Set(input.items.map((line) => line.menuItemId))];
  const menus = await MenuItem.find({
    _id: { $in: menuIds },
    businessId,
    isActive: true,
  });
  if (menus.length !== menuIds.length)
    throw new HttpError(422, "One or more menu items are unavailable");
  const batchIds = [
    ...new Set(
      input.items
        .map((line) => line.cookingBatchId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const batches = await CookingBatch.find({
    _id: { $in: batchIds },
    businessId,
    status: "COMPLETED",
  });
  if (batches.length !== batchIds.length)
    throw new HttpError(422, "One or more cooking batches are unavailable");
  const directMenuIds = [
    ...new Set(input.items.filter((line) => !line.cookingBatchId).map((line) => line.menuItemId)),
  ];
  const recipeIds = [
    ...new Set(
      menus.filter((menu) => directMenuIds.includes(menu.id)).map((menu) => String(menu.recipeId)),
    ),
  ];
  const recipes = await Recipe.find({
    _id: { $in: recipeIds },
    businessId,
    isActive: true,
  });
  if (recipes.length !== recipeIds.length)
    throw new HttpError(422, "One or more menu items do not have an active recipe");
  const lines = input.items.map((line) => {
    const menu = menus.find((item) => item.id === line.menuItemId);
    if (!menu) throw new HttpError(422, "Menu item is unavailable");
    const batch = line.cookingBatchId
      ? batches.find((item) => item.id === line.cookingBatchId)
      : undefined;
    if (line.cookingBatchId && (!batch || String(batch.menuItemId) !== line.menuItemId))
      throw new HttpError(422, `The selected cooking batch does not belong to ${menu.name}`);
    if (batch && decimal(batch.servingsRemainingCached?.toString()).lessThan(line.quantitySold))
      throw new HttpError(422, `Not enough remaining servings in ${batch.cookingBatchNumber}`);
    const price = decimal(menu.sellingPricePerServing?.toString());
    const cost = decimal(
      batch?.costPerServing?.toString() ?? menu.calculatedCostPerServingCached?.toString(),
    );
    const gross = price.times(line.quantitySold);
    const net = gross.minus(line.discount);
    if (net.lessThan(0)) throw new HttpError(422, "Discount cannot exceed the order line total");
    const totalCost = cost.times(line.quantitySold);
    return {
      menuItemId: menu._id,
      menuNameSnapshot: menu.name,
      quantitySold: line.quantitySold,
      sellingPricePerServing: price.toString(),
      grossAmount: gross.toString(),
      discount: line.discount,
      netAmount: net.toString(),
      costPerServingSnapshot: cost.toString(),
      totalCost: totalCost.toString(),
      grossProfit: net.minus(totalCost).toString(),
      cookingBatchAllocations: batch
        ? [{ cookingBatchId: batch._id, quantity: line.quantitySold }]
        : [],
    };
  });

  const requirements = new Map<
    string,
    { inventoryItemId: Types.ObjectId; quantity: ReturnType<typeof decimal> }
  >();
  for (const line of input.items) {
    if (line.cookingBatchId) continue;
    const menu = menus.find((item) => item.id === line.menuItemId);
    const recipe = recipes.find((item) => item.id === String(menu?.recipeId));
    if (!recipe?.ingredients.length)
      throw new HttpError(422, `${menu?.name ?? "Menu item"} needs at least one recipe ingredient`);
    const servings = decimal(recipe.yieldServings?.toString());
    if (!servings.greaterThan(0)) throw new HttpError(422, `${recipe.name} has an invalid yield`);
    for (const ingredient of recipe.ingredients) {
      const id = String(ingredient.inventoryItemId);
      const required = decimal(
        calculateRecipeIngredientUsage(
          ingredient.quantity?.toString() ?? 0,
          line.quantitySold,
          servings.toString(),
        ),
      );
      const existing = requirements.get(id);
      requirements.set(id, {
        inventoryItemId: ingredient.inventoryItemId,
        quantity: existing ? existing.quantity.plus(required) : required,
      });
    }
  }

  const inventoryItems = await InventoryItem.find({
    _id: { $in: [...requirements.keys()] },
    businessId,
    isActive: true,
  });
  if (inventoryItems.length !== requirements.size)
    throw new HttpError(422, "One or more recipe ingredients are unavailable in inventory");
  for (const [id, requirement] of requirements) {
    const item = inventoryItems.find((candidate) => candidate.id === id);
    if (!item || decimal(item.currentStockCached?.toString()).lessThan(requirement.quantity))
      throw new HttpError(422, `Not enough ${item?.name ?? "ingredient"} in inventory`);
  }

  const grossSales = lines.reduce((sum, line) => sum.plus(line.grossAmount), decimal(0));
  const discount = lines.reduce((sum, line) => sum.plus(line.discount), decimal(0));
  const totalCost = lines.reduce((sum, line) => sum.plus(line.totalCost), decimal(0));
  const netSales = grossSales.minus(discount);
  const sale = await KarenderiyaSale.create({
    businessId,
    salesNumber: `KS-${Date.now()}`,
    salesDate: input.salesDate,
    items: lines,
    grossSales: grossSales.toString(),
    discountTotal: discount.toString(),
    netSales: netSales.toString(),
    costOfFoodSold: totalCost.toString(),
    grossProfit: netSales.minus(totalCost).toString(),
    amountReceived: netSales.toString(),
    receivingAccountId: input.receivingAccountId,
    notes: input.notes,
    status: "DRAFT",
  });

  for (const line of input.items) {
    if (!line.cookingBatchId) continue;
    const batch = batches.find((candidate) => candidate.id === line.cookingBatchId);
    if (!batch) throw new HttpError(422, "Cooking batch was not found");
    const updated = await CookingBatch.findOneAndUpdate(
      {
        _id: batch._id,
        businessId,
        status: "COMPLETED",
        servingsRemainingCached: { $gte: line.quantitySold },
      },
      {
        $inc: {
          servingsSoldCached: line.quantitySold,
          servingsRemainingCached: -line.quantitySold,
        },
      },
      { new: true },
    );
    if (!updated)
      throw new HttpError(422, `Not enough remaining servings in ${batch.cookingBatchNumber}`);
  }
  const usages = [];
  let movementIndex = 0;
  for (const [id, requirement] of requirements) {
    const item = inventoryItems.find((candidate) => candidate.id === id);
    if (!item) throw new HttpError(422, "Recipe ingredient was not found");
    const quantity = requirement.quantity.toString();
    const updated = await InventoryItem.findOneAndUpdate(
      { _id: item._id, businessId, currentStockCached: { $gte: quantity } },
      { $inc: { currentStockCached: requirement.quantity.negated().toString() } },
      { new: true },
    );
    if (!updated) throw new HttpError(422, `Not enough ${item.name} in inventory`);

    const unitCost = decimal(
      item.defaultKarenderiyaTransferPricePerUnit?.toString() ??
        item.defaultExternalPricePerUnit?.toString() ??
        0,
    );
    const totalUsageCost = unitCost.times(requirement.quantity);
    const movement = await InventoryMovement.create({
      businessId,
      movementNumber: `KCON-${Date.now()}-${movementIndex++}-${Math.floor(Math.random() * 1000)}`,
      movementDate: input.salesDate,
      movementType: "CONSUMPTION",
      itemId: item._id,
      fromBusinessUnit: "KARENDERIYA",
      toBusinessUnit: null,
      quantity,
      unit: item.baseUnit,
      unitCostSnapshot: unitCost.toString(),
      totalCost: totalUsageCost.toString(),
      allocations: [{ targetType: "GENERAL", quantity, allocatedCost: totalUsageCost.toString() }],
      source: { collection: "karenderiya_sales", documentId: sale._id },
      reason: `Ingredients used by ${sale.salesNumber}`,
      status: "POSTED",
    });

    usages.push({
      inventoryItemId: item._id,
      itemNameSnapshot: item.name,
      quantityUsed: quantity,
      unit: item.baseUnit,
      unitCostSnapshot: unitCost.toString(),
      totalCost: totalUsageCost.toString(),
      inventoryMovementId: movement._id,
    });
  }
  const transaction = await postCash(
    businessId,
    {
      transactionDate: input.salesDate,
      businessUnit: "KARENDERIYA",
      transactionType: "CASH_IN",
      category: "SALE_COLLECTION",
      amount: Number(moneyString(netSales)),
      accountId: input.receivingAccountId,
      description: `Karenderiya order ${sale.salesNumber}`,
    },
    { collection: "karenderiya_sales", documentId: sale._id },
  );

  sale.ingredientUsages = usages;
  sale.cashTransactionId = transaction._id;
  sale.status = "POSTED";
  await sale.save();
  return sale;
}

async function updateKarenderiyaSaleInTransaction(
  businessId: Types.ObjectId,
  saleId: string,
  input: { salesDate: Date; notes?: string },
) {
  const sale = await KarenderiyaSale.findOne({ _id: saleId, businessId, status: "POSTED" });
  if (!sale) throw new HttpError(404, "Order transaction was not found");
  sale.salesDate = input.salesDate;
  sale.notes = input.notes;
  await sale.save();
  await CashTransaction.updateOne(
    { _id: sale.cashTransactionId, businessId, status: "POSTED" },
    { transactionDate: input.salesDate },
  );
  await InventoryMovement.updateMany(
    { _id: { $in: sale.ingredientUsages.map((usage: any) => usage.inventoryMovementId) } },
    { movementDate: input.salesDate },
  );
  return sale;
}

async function deleteKarenderiyaSaleInTransaction(businessId: Types.ObjectId, saleId: string) {
  const sale = await KarenderiyaSale.findOne({ _id: saleId, businessId, status: "POSTED" });
  if (!sale) throw new HttpError(404, "Order transaction was not found");
  if (sale.cashTransactionId) await reverseCashTransaction(businessId, sale.cashTransactionId);
  for (const usage of sale.ingredientUsages) {
    await InventoryItem.updateOne(
      { _id: usage.inventoryItemId, businessId },
      { $inc: { currentStockCached: usage.quantityUsed?.toString() ?? 0 } },
    );
  }
  for (const line of sale.items) {
    for (const allocation of line.cookingBatchAllocations ?? []) {
      const quantity = Number(allocation.quantity?.toString() ?? 0);
      await CookingBatch.updateOne(
        { _id: allocation.cookingBatchId, businessId },
        { $inc: { servingsSoldCached: -quantity, servingsRemainingCached: quantity } },
      );
    }
  }
  await InventoryMovement.updateMany(
    { _id: { $in: sale.ingredientUsages.map((usage: any) => usage.inventoryMovementId) } },
    { status: "VOIDED", reason: `Voided order ${sale.salesNumber}` },
  );
  sale.status = "VOIDED";
  await sale.save();
}

export const postCash = (...args: Parameters<typeof postCashInTransaction>) =>
  inTransaction(() => postCashInTransaction(...args));

export const reverseExpenseCashWithoutExpense = (
  ...args: Parameters<typeof reverseExpenseCashWithoutExpenseInTransaction>
) => inTransaction(() => reverseExpenseCashWithoutExpenseInTransaction(...args));

export const postExpense = (...args: Parameters<typeof postExpenseInTransaction>) =>
  inTransaction(() => postExpenseInTransaction(...args));

export const updateExpense = (...args: Parameters<typeof updateExpenseInTransaction>) =>
  inTransaction(() => updateExpenseInTransaction(...args));

export const deleteExpense = (...args: Parameters<typeof deleteExpenseInTransaction>) =>
  inTransaction(() => deleteExpenseInTransaction(...args));

export const postKarenderiyaSale = (...args: Parameters<typeof postKarenderiyaSaleInTransaction>) =>
  inTransaction(() => postKarenderiyaSaleInTransaction(...args));

export const updateKarenderiyaSale = (
  ...args: Parameters<typeof updateKarenderiyaSaleInTransaction>
) => inTransaction(() => updateKarenderiyaSaleInTransaction(...args));

export const deleteKarenderiyaSale = (
  ...args: Parameters<typeof deleteKarenderiyaSaleInTransaction>
) => inTransaction(() => deleteKarenderiyaSaleInTransaction(...args));
