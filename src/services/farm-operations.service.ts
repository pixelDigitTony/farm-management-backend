import type { Types } from "mongoose";
import type { InferOutput } from "valibot";
import { decimal } from "../lib/decimal.js";
import { HttpError } from "../lib/http-error.js";
import {
  CashAccount,
  CookingBatch,
  Expense,
  FeedUsageRecord,
  InventoryItem,
  InventoryLot,
  InventoryMovement,
  MenuItem,
  Pig,
  PiggerySale,
  PigMeasurement,
  Recipe,
  SlaughterRecord,
} from "../models/index.js";
import type {
  cookingBatchOperationSchema,
  feedUsageOperationSchema,
  inventoryReceiptOperationSchema,
  meatTransferOperationSchema,
  pigAcquisitionOperationSchema,
  piggerySaleOperationSchema,
  pigMeasurementOperationSchema,
  slaughterOperationSchema,
} from "../validation/operations.js";
import { calculateSlaughter } from "./calculation.service.js";
import {
  deleteExpense,
  postCash,
  postExpense,
  reverseExpenseCashWithoutExpense,
} from "./posting.service.js";

type InventoryReceiptInput = InferOutput<typeof inventoryReceiptOperationSchema>;
type FeedUsageInput = InferOutput<typeof feedUsageOperationSchema>;
type SlaughterInput = InferOutput<typeof slaughterOperationSchema>;
type MeatTransferInput = InferOutput<typeof meatTransferOperationSchema>;
type PigMeasurementInput = InferOutput<typeof pigMeasurementOperationSchema>;
type PigAcquisitionInput = InferOutput<typeof pigAcquisitionOperationSchema>;
type PiggerySaleInput = InferOutput<typeof piggerySaleOperationSchema>;
type CookingBatchInput = InferOutput<typeof cookingBatchOperationSchema>;

const reference = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

async function requireCashAccount(
  businessId: Types.ObjectId,
  accountId: string | undefined,
  amount: number,
) {
  if (amount <= 0) return;
  if (!accountId) throw new HttpError(422, "Select the cash account used for payment");
  if (!(await CashAccount.exists({ _id: accountId, businessId, isActive: true })))
    throw new HttpError(422, "Cash account was not found");
}

export async function postInventoryReceipt(
  businessId: Types.ObjectId,
  input: InventoryReceiptInput,
) {
  const item = await InventoryItem.findOne({ _id: input.itemId, businessId, isActive: true });
  if (!item) throw new HttpError(404, "Inventory item was not found");
  await requireCashAccount(businessId, input.accountId, input.amountPaid);
  const totalCost = decimal(input.quantity).times(input.unitCost);
  if (decimal(input.amountPaid).greaterThan(totalCost))
    throw new HttpError(422, "Amount paid cannot exceed the receipt total");

  const lot = await InventoryLot.create({
    businessId,
    itemId: item._id,
    lotCode: reference("LOT"),
    sourceType: "PURCHASE",
    businessUnit: input.businessUnit,
    storageLocation: input.storageLocation,
    receivedDate: input.movementDate,
    expiryDate: input.expiryDate,
    initialQuantity: input.quantity,
    remainingQuantityCached: input.quantity,
    unitCost: input.unitCost,
    totalCost: totalCost.toString(),
  });
  const movement = await InventoryMovement.create({
    businessId,
    movementNumber: reference("RCV"),
    movementDate: input.movementDate,
    movementType: "RECEIPT",
    itemId: item._id,
    toBusinessUnit: input.businessUnit,
    toLotId: lot._id,
    quantity: input.quantity,
    unit: item.baseUnit,
    unitCostSnapshot: input.unitCost,
    totalCost: totalCost.toString(),
    reason: input.notes || `Inventory receipt for ${item.name}`,
  });
  let postedExpenseId: string | undefined;
  try {
    await InventoryItem.updateOne(
      { _id: item._id, businessId },
      {
        $inc: { currentStockCached: input.quantity },
        $set: { defaultExternalPricePerUnit: input.unitCost },
      },
    );
    const expense = await postExpense(businessId, {
      expenseNumber: reference("EXP"),
      expenseDate: input.movementDate,
      businessUnit: input.businessUnit,
      category:
        item.category === "FEED"
          ? "FEED"
          : item.category === "INGREDIENT" || item.category === "MEAT"
            ? "INGREDIENT"
            : "SUPPLY",
      description: `Inventory purchase: ${item.name}`,
      totalAmount: Number(totalCost.toString()),
      amountPaid: input.amountPaid,
      accountId: input.accountId,
    });
    postedExpenseId = expense.id;
    movement.source = { collection: "expenses", documentId: expense._id };
    lot.sourceDocumentId = expense._id;
    await Promise.all([movement.save(), lot.save()]);
    return { item, lot, movement, expense };
  } catch (error) {
    if (postedExpenseId) await deleteExpense(businessId, postedExpenseId);
    await Promise.all([
      InventoryItem.updateOne(
        { _id: item._id, businessId },
        { $inc: { currentStockCached: -input.quantity } },
      ),
      InventoryMovement.deleteOne({ _id: movement._id }),
      InventoryLot.deleteOne({ _id: lot._id }),
    ]);
    throw error;
  }
}

export async function postFeedUsage(businessId: Types.ObjectId, input: FeedUsageInput) {
  if (input.allocationType === "PIG" && !input.pigId)
    throw new HttpError(422, "Select the pig receiving the feed cost");
  if (input.allocationType === "PIG_BATCH" && !input.batchId)
    throw new HttpError(422, "Select the pig batch receiving the feed cost");
  const item = await InventoryItem.findOne({
    _id: input.feedItemId,
    businessId,
    category: "FEED",
    isActive: true,
  });
  if (!item) throw new HttpError(404, "Feed inventory item was not found");
  const lot = input.inventoryLotId
    ? await InventoryLot.findOne({
        _id: input.inventoryLotId,
        itemId: item._id,
        businessId,
        status: "ACTIVE",
      })
    : null;
  if (input.inventoryLotId && !lot) throw new HttpError(404, "Feed inventory lot was not found");
  if (decimal(item.currentStockCached?.toString()).lessThan(input.quantityUsed))
    throw new HttpError(422, `Not enough ${item.name} in inventory`);
  if (lot && decimal(lot.remainingQuantityCached?.toString()).lessThan(input.quantityUsed))
    throw new HttpError(422, `Not enough ${item.name} in the selected lot`);

  const unitCost = decimal(
    lot?.unitCost?.toString() ?? item.defaultExternalPricePerUnit?.toString() ?? 0,
  );
  const totalFeedCost = unitCost.times(input.quantityUsed);
  let costPerPig = totalFeedCost;
  let affectedPigIds: Types.ObjectId[] = [];
  if (input.allocationType === "PIG") {
    const pig = await Pig.findOne({ _id: input.pigId, businessId, status: "ACTIVE" });
    if (!pig) throw new HttpError(422, "Active pig was not found");
    affectedPigIds = [pig._id];
  }
  if (input.allocationType === "PIG_BATCH") {
    const pigs = await Pig.find({ batchId: input.batchId, businessId, status: "ACTIVE" }).select(
      "_id",
    );
    if (!pigs.length) throw new HttpError(422, "The selected batch has no active pigs");
    affectedPigIds = pigs.map((pig) => pig._id);
    costPerPig = totalFeedCost.dividedBy(pigs.length);
  }

  const usage = await FeedUsageRecord.create({
    businessId,
    usageNumber: reference("FEED"),
    usageDate: input.usageDate,
    feedItemId: item._id,
    inventoryLotId: lot?._id,
    allocationType: input.allocationType,
    pigId: input.pigId,
    batchId: input.batchId,
    headCount: affectedPigIds.length || undefined,
    quantityUsed: input.quantityUsed,
    unitCostSnapshot: unitCost.toString(),
    totalFeedCost: totalFeedCost.toString(),
    costPerPig: affectedPigIds.length ? costPerPig.toString() : null,
    notes: input.notes,
    status: "DRAFT",
  });
  const stock = await InventoryItem.findOneAndUpdate(
    { _id: item._id, businessId, currentStockCached: { $gte: input.quantityUsed } },
    { $inc: { currentStockCached: -input.quantityUsed } },
    { new: true },
  );
  if (!stock) {
    await usage.deleteOne();
    throw new HttpError(422, `Not enough ${item.name} in inventory`);
  }
  let movementId: Types.ObjectId | undefined;
  let pigCostApplied = false;
  try {
    if (lot) {
      lot.remainingQuantityCached = decimal(lot.remainingQuantityCached?.toString())
        .minus(input.quantityUsed)
        .toString() as any;
      if (decimal(lot.remainingQuantityCached?.toString()).isZero()) lot.status = "DEPLETED";
      await lot.save();
    }
    const movement = await InventoryMovement.create({
      businessId,
      movementNumber: reference("FCON"),
      movementDate: input.usageDate,
      movementType: "CONSUMPTION",
      itemId: item._id,
      fromBusinessUnit: "PIGGERY",
      fromLotId: lot?._id,
      quantity: input.quantityUsed,
      unit: item.baseUnit,
      unitCostSnapshot: unitCost.toString(),
      totalCost: totalFeedCost.toString(),
      allocations: affectedPigIds.map((pigId) => ({
        targetType: "PIG",
        targetId: pigId,
        quantity: decimal(input.quantityUsed)
          .dividedBy(affectedPigIds.length || 1)
          .toString(),
        allocatedCost: costPerPig.toString(),
      })),
      source: { collection: "feed_usage_records", documentId: usage._id },
      reason: input.notes || `Feed usage for ${item.name}`,
    });
    movementId = movement._id;
    if (affectedPigIds.length)
      await Pig.updateMany(
        { _id: { $in: affectedPigIds }, businessId },
        { $inc: { accumulatedCostCached: Number(costPerPig.toString()) } },
      );
    pigCostApplied = affectedPigIds.length > 0;
    usage.inventoryMovementId = movement._id;
    usage.status = "POSTED";
    await usage.save();
    return usage;
  } catch (error) {
    await InventoryItem.updateOne(
      { _id: item._id, businessId },
      { $inc: { currentStockCached: input.quantityUsed } },
    );
    if (lot) {
      lot.remainingQuantityCached = decimal(lot.remainingQuantityCached?.toString())
        .plus(input.quantityUsed)
        .toString() as any;
      lot.status = "ACTIVE";
      await lot.save();
    }
    if (pigCostApplied)
      await Pig.updateMany(
        { _id: { $in: affectedPigIds }, businessId },
        { $inc: { accumulatedCostCached: -Number(costPerPig.toString()) } },
      );
    if (movementId) await InventoryMovement.deleteOne({ _id: movementId });
    await usage.deleteOne();
    throw error;
  }
}

export async function postPigMeasurement(businessId: Types.ObjectId, input: PigMeasurementInput) {
  const pig = await Pig.findOne({ _id: input.pigId, businessId, status: "ACTIVE" });
  if (!pig) throw new HttpError(422, "Select an active pig to record its weight");
  const measurement = await PigMeasurement.create({
    businessId,
    measurementDate: input.measurementDate,
    measurementType: "INDIVIDUAL",
    pigId: pig._id,
    weightKg: input.weightKg,
    notes: input.notes,
  });
  pig.latestWeightKgCached = input.weightKg as any;
  await pig.save();
  return measurement;
}

export async function postPigAcquisition(businessId: Types.ObjectId, input: PigAcquisitionInput) {
  if (input.amountPaid > input.purchaseCost)
    throw new HttpError(422, "Amount paid cannot exceed the pig purchase cost");
  await requireCashAccount(businessId, input.accountId, input.amountPaid);
  const pig = await Pig.create({
    businessId,
    pigCode: input.pigCode,
    earTag: input.earTag,
    batchId: input.batchId,
    sex: input.sex,
    breed: input.breed,
    acquisitionDate: input.acquisitionDate,
    purchaseCost: input.purchaseCost,
    accumulatedCostCached: input.purchaseCost,
    currentPen: input.currentPen,
    latestWeightKgCached: input.latestWeightKgCached,
    notes: input.notes,
    status: "ACTIVE",
  });
  let postedExpenseId: string | undefined;
  try {
    const expense = await postExpense(businessId, {
      expenseNumber: reference("EXP-PIG"),
      expenseDate: input.acquisitionDate,
      businessUnit: "PIGGERY",
      category: "PIG_PURCHASE",
      description: `Pig purchase: ${pig.pigCode}`,
      totalAmount: input.purchaseCost,
      amountPaid: input.amountPaid,
      accountId: input.accountId,
    });
    postedExpenseId = expense.id;
    expense.allocations = [
      {
        targetType: "PIG",
        targetId: pig._id,
        allocationMethod: "AMOUNT",
        value: input.purchaseCost,
        allocatedAmount: input.purchaseCost,
      },
    ] as any;
    await expense.save();
    return { pig, expense };
  } catch (error) {
    if (postedExpenseId) await deleteExpense(businessId, postedExpenseId);
    await pig.deleteOne();
    throw error;
  }
}

export async function deletePigAcquisition(businessId: Types.ObjectId, pigId: string) {
  const pig = await Pig.findOne({ _id: pigId, businessId, status: "ACTIVE" });
  if (!pig) throw new HttpError(404, "Active pig was not found");
  const [measurement, feed, slaughter, sale] = await Promise.all([
    PigMeasurement.exists({ businessId, pigId: pig._id }),
    FeedUsageRecord.exists({ businessId, pigId: pig._id }),
    SlaughterRecord.exists({ businessId, pigId: pig._id }),
    PiggerySale.exists({ businessId, "items.pigId": pig._id }),
  ]);
  if (measurement || feed || slaughter || sale)
    throw new HttpError(409, "This pig already has operational history and cannot be deleted");
  const expense = await Expense.findOne({
    businessId,
    "allocations.targetType": "PIG",
    "allocations.targetId": pig._id,
  });
  if (expense) await deleteExpense(businessId, expense.id);
  await pig.deleteOne();
}

type SlaughterPostOptions = { recordId?: string; slaughterNumber?: string };

export async function postSlaughterRecord(
  businessId: Types.ObjectId,
  input: SlaughterInput,
  options: SlaughterPostOptions = {},
) {
  const pig = await Pig.findOne({ _id: input.pigId, businessId, status: "ACTIVE" });
  if (!pig) throw new HttpError(422, "Select an active pig for slaughter");
  await requireCashAccount(businessId, input.accountId, input.amountPaid);
  const raisingCost = Number(pig.accumulatedCostCached?.toString() ?? 0);
  const quote = calculateSlaughter({
    raisingCost,
    liveWeightKg: input.liveWeightKg,
    carcassWeightKg: input.carcassWeightKg,
    costs: input.costs,
    parts: input.parts.map((part) => ({
      name: part.name,
      classification: part.classification,
      weightKg: part.weightKg,
      pricePerKg: part.externalPricePerKg,
    })),
  });
  const slaughterNumber = options.slaughterNumber ?? reference("SLT");
  const recordData = {
    businessId,
    slaughterNumber,
    pigId: pig._id,
    batchId: pig.batchId,
    slaughterDate: input.slaughterDate,
    liveWeightKg: input.liveWeightKg,
    wholeCarcassWeightKg: input.carcassWeightKg,
    usablePartsWeightKg: quote.usableWeightKg,
    wasteWeightKg: quote.wasteWeightKg,
    unaccountedWeightKg: quote.unaccountedWeightKg,
    raisingCostAtSlaughter: raisingCost,
    costLines: input.costs.map((cost) => ({
      name: cost.name,
      calculationMethod: "MANUAL",
      amount: cost.amount,
    })),
    totalSlaughterCost: quote.slaughterCost,
    totalPigAndSlaughterCost: quote.totalCost,
    averageUsableMeatCostPerKg: quote.costPerUsableKg,
    dressingPercentage: quote.dressingPercentage,
    usableYieldPercentage: quote.usableYieldPercentage,
    notes: input.notes,
    status: "DRAFT",
  };
  const record = options.recordId
    ? await SlaughterRecord.findOneAndUpdate({ _id: options.recordId, businessId }, recordData, {
        new: true,
        runValidators: true,
      })
    : await SlaughterRecord.create(recordData);
  if (!record) throw new HttpError(404, "Slaughter record was not found");
  const createdLots: Array<{ itemId: Types.ObjectId; lotId: Types.ObjectId; quantity: number }> =
    [];
  const createdMovementIds: Types.ObjectId[] = [];
  let postedExpenseId: string | undefined;
  try {
    const storedParts = [];
    for (const [index, part] of input.parts.entries()) {
      if (part.classification === "WASTE" || part.weightKg <= 0) {
        storedParts.push({
          partCode: `PART-${index + 1}`,
          partName: part.name,
          classification: part.classification,
          weightKg: part.weightKg,
          allocatedCost: 0,
          productionCostPerKg: 0,
          externalPricePerKg: part.externalPricePerKg,
          karenderiyaTransferPricePerKg: part.karenderiyaTransferPricePerKg,
        });
        continue;
      }
      let item = await InventoryItem.findOne({
        businessId,
        name: part.name,
        category: part.classification === "MEAT" ? "MEAT" : "BYPRODUCT",
      });
      if (!item)
        item = await InventoryItem.create({
          businessId,
          itemCode: reference(part.classification === "MEAT" ? "MEAT" : "BYPROD"),
          name: part.name,
          businessUnit: "PIGGERY",
          category: part.classification === "MEAT" ? "MEAT" : "BYPRODUCT",
          baseUnit: "KG",
          defaultExternalPricePerUnit: part.externalPricePerKg,
          defaultKarenderiyaTransferPricePerUnit: part.karenderiyaTransferPricePerKg,
          currentStockCached: 0,
          isPerishable: true,
        });
      const allocatedCost = decimal(quote.costPerUsableKg).times(part.weightKg);
      const lot = await InventoryLot.create({
        businessId,
        itemId: item._id,
        lotCode: `${slaughterNumber}-${index + 1}`,
        sourceType: "SLAUGHTER",
        sourceDocumentId: record._id,
        businessUnit: "PIGGERY",
        receivedDate: input.slaughterDate,
        initialQuantity: part.weightKg,
        remainingQuantityCached: part.weightKg,
        unitCost: quote.costPerUsableKg,
        totalCost: allocatedCost.toString(),
      });
      await InventoryItem.updateOne(
        { _id: item._id, businessId },
        {
          $inc: { currentStockCached: part.weightKg },
          $set: {
            defaultExternalPricePerUnit: part.externalPricePerKg,
            defaultKarenderiyaTransferPricePerUnit: part.karenderiyaTransferPricePerKg,
          },
        },
      );
      createdLots.push({ itemId: item._id, lotId: lot._id, quantity: part.weightKg });
      const movement = await InventoryMovement.create({
        businessId,
        movementNumber: reference("PROD"),
        movementDate: input.slaughterDate,
        movementType: "PRODUCTION",
        itemId: item._id,
        toBusinessUnit: "PIGGERY",
        toLotId: lot._id,
        quantity: part.weightKg,
        unit: "KG",
        unitCostSnapshot: quote.costPerUsableKg,
        totalCost: allocatedCost.toString(),
        source: { collection: "slaughter_records", documentId: record._id },
        reason: `Produced by ${slaughterNumber}`,
      });
      createdMovementIds.push(movement._id);
      storedParts.push({
        inventoryItemId: item._id,
        partCode: item.itemCode,
        partName: part.name,
        classification: part.classification,
        weightKg: part.weightKg,
        allocatedCost: allocatedCost.toString(),
        productionCostPerKg: quote.costPerUsableKg,
        externalPricePerKg: part.externalPricePerKg,
        karenderiyaTransferPricePerKg: part.karenderiyaTransferPricePerKg,
        producedLotId: lot._id,
      });
    }
    let expense: InstanceType<typeof Expense> | undefined;
    if (Number(quote.slaughterCost) > 0)
      expense = await postExpense(businessId, {
        expenseNumber: reference("EXP-SLT"),
        expenseDate: input.slaughterDate,
        businessUnit: "PIGGERY",
        category: "SLAUGHTER",
        description: `Slaughter costs for ${pig.pigCode}`,
        totalAmount: Number(quote.slaughterCost),
        amountPaid: input.amountPaid,
        accountId: input.accountId,
      });
    postedExpenseId = expense?.id;
    record.parts = storedParts as any;
    record.status = "COMPLETED";
    if (expense && record.costLines[0]) record.costLines[0].expenseId = expense._id;
    await record.save();
    pig.status = "SLAUGHTERED";
    pig.statusDate = input.slaughterDate;
    pig.latestWeightKgCached = input.liveWeightKg as any;
    await pig.save();
    return record;
  } catch (error) {
    if (postedExpenseId) await deleteExpense(businessId, postedExpenseId);
    for (const created of createdLots)
      await InventoryItem.updateOne(
        { _id: created.itemId, businessId },
        { $inc: { currentStockCached: -created.quantity } },
      );
    await Promise.all([
      InventoryLot.deleteMany({ _id: { $in: createdLots.map((item) => item.lotId) } }),
      InventoryMovement.deleteMany({ _id: { $in: createdMovementIds } }),
      options.recordId
        ? SlaughterRecord.updateOne(
            { _id: record._id, businessId },
            { $set: { parts: [], status: "DRAFT" } },
          )
        : record.deleteOne(),
    ]);
    throw error;
  }
}

async function reverseSlaughterEffects(
  businessId: Types.ObjectId,
  record: InstanceType<typeof SlaughterRecord>,
  keepRecord: boolean,
  allowMissingExpense = false,
) {
  if (record.status !== "COMPLETED")
    throw new HttpError(409, "Only completed slaughter records can be corrected or deleted");
  const lotIds = record.parts
    .map((part: any) => part.producedLotId)
    .filter((id: unknown): id is Types.ObjectId => Boolean(id));
  if (
    lotIds.length &&
    (await InventoryMovement.exists({
      businessId,
      fromLotId: { $in: lotIds },
      status: "POSTED",
    }))
  )
    throw new HttpError(
      409,
      "This slaughter produced meat that was already transferred, consumed, or sold",
    );

  const quantities = new Map<string, number>();
  for (const part of record.parts as any[]) {
    if (!part.inventoryItemId || Number(part.weightKg) <= 0) continue;
    const key = String(part.inventoryItemId);
    quantities.set(key, (quantities.get(key) ?? 0) + Number(part.weightKg));
  }
  const items = await InventoryItem.find({
    _id: { $in: [...quantities.keys()] },
    businessId,
  });
  for (const [itemId, quantity] of quantities) {
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item || decimal(item.currentStockCached?.toString()).lessThan(quantity))
      throw new HttpError(
        409,
        "This slaughter cannot be changed because some produced stock is no longer available",
      );
  }

  const expenseId = (record.costLines as any[]).find((line) => line.expenseId)?.expenseId;
  if (expenseId) {
    const expenseExists = await Expense.exists({ _id: expenseId, businessId });
    if (expenseExists) await deleteExpense(businessId, String(expenseId));
    else if (!allowMissingExpense)
      throw new HttpError(
        409,
        "The linked slaughter expense is missing. Confirm deletion without the expense to continue.",
        { expenseId: String(expenseId) },
        "SLAUGHTER_EXPENSE_NOT_FOUND",
      );
    else await reverseExpenseCashWithoutExpense(businessId, expenseId);
  }
  for (const [itemId, quantity] of quantities)
    await InventoryItem.updateOne(
      { _id: itemId, businessId },
      { $inc: { currentStockCached: -quantity } },
    );
  await Promise.all([
    InventoryMovement.deleteMany({
      businessId,
      "source.collection": "slaughter_records",
      "source.documentId": record._id,
    }),
    InventoryLot.deleteMany({ _id: { $in: lotIds }, businessId }),
  ]);
  const latestMeasurement = await PigMeasurement.findOne({
    businessId,
    pigId: record.pigId,
  })
    .sort({ measurementDate: -1 })
    .select("weightKg")
    .lean();
  await Pig.updateOne(
    { _id: record.pigId, businessId },
    {
      $set: {
        status: "ACTIVE",
        statusDate: null,
        latestWeightKgCached: latestMeasurement?.weightKg ?? null,
      },
    },
  );
  if (keepRecord)
    await SlaughterRecord.updateOne(
      { _id: record._id, businessId },
      { $set: { parts: [], status: "DRAFT" } },
    );
  else await record.deleteOne();
}

export async function updateSlaughterRecord(
  businessId: Types.ObjectId,
  recordId: string,
  input: SlaughterInput,
) {
  const record = await SlaughterRecord.findOne({ _id: recordId, businessId });
  if (!record) throw new HttpError(404, "Slaughter record was not found");
  if (String(record.pigId) !== input.pigId)
    throw new HttpError(422, "The pig on a completed slaughter record cannot be changed");
  const expenseId = (record.costLines as any[]).find((line) => line.expenseId)?.expenseId;
  const expense = expenseId ? await Expense.findOne({ _id: expenseId, businessId }).lean() : null;
  const previousInput: SlaughterInput = {
    pigId: String(record.pigId),
    slaughterDate: record.slaughterDate,
    liveWeightKg: Number(record.liveWeightKg?.toString() ?? 0),
    carcassWeightKg: Number(record.wholeCarcassWeightKg?.toString() ?? 0),
    costs: (record.costLines as any[]).map((line) => ({
      name: line.name,
      amount: Number(line.amount?.toString() ?? 0),
    })),
    parts: (record.parts as any[]).map((part) => ({
      name: part.partName,
      classification: part.classification,
      weightKg: Number(part.weightKg?.toString() ?? 0),
      externalPricePerKg: Number(part.externalPricePerKg?.toString() ?? 0),
      karenderiyaTransferPricePerKg: Number(part.karenderiyaTransferPricePerKg?.toString() ?? 0),
    })),
    amountPaid: Number(expense?.amountPaidCached?.toString() ?? 0),
    accountId: expense?.paymentAccountIdCached ? String(expense.paymentAccountIdCached) : undefined,
    notes: record.notes,
  };
  const slaughterNumber = record.slaughterNumber;
  await reverseSlaughterEffects(businessId, record, true);
  try {
    return await postSlaughterRecord(businessId, input, { recordId, slaughterNumber });
  } catch (error) {
    try {
      await postSlaughterRecord(businessId, previousInput, { recordId, slaughterNumber });
    } catch {
      throw new HttpError(
        500,
        "The correction failed and the original slaughter record could not be restored",
      );
    }
    throw error;
  }
}

export async function deleteSlaughterRecord(
  businessId: Types.ObjectId,
  recordId: string,
  allowMissingExpense = false,
) {
  const record = await SlaughterRecord.findOne({ _id: recordId, businessId });
  if (!record) throw new HttpError(404, "Slaughter record was not found");
  await reverseSlaughterEffects(businessId, record, false, allowMissingExpense);
}

export async function postMeatTransfer(businessId: Types.ObjectId, input: MeatTransferInput) {
  const [item, sourceLot] = await Promise.all([
    InventoryItem.findOne({
      _id: input.inventoryItemId,
      businessId,
      category: { $in: ["MEAT", "BYPRODUCT"] },
      isActive: true,
    }),
    InventoryLot.findOne({
      _id: input.sourceLotId,
      itemId: input.inventoryItemId,
      businessId,
      businessUnit: "PIGGERY",
      status: "ACTIVE",
    }),
  ]);
  if (!item || !sourceLot) throw new HttpError(404, "Piggery meat lot was not found");
  if (decimal(sourceLot.remainingQuantityCached?.toString()).lessThan(input.quantity))
    throw new HttpError(422, "Transfer quantity exceeds the available piggery lot");
  const unitCost = decimal(
    input.transferPricePerKg ??
      item.defaultKarenderiyaTransferPricePerUnit?.toString() ??
      sourceLot.unitCost?.toString() ??
      0,
  );
  sourceLot.remainingQuantityCached = decimal(sourceLot.remainingQuantityCached?.toString())
    .minus(input.quantity)
    .toString() as any;
  if (decimal(sourceLot.remainingQuantityCached?.toString()).isZero())
    sourceLot.status = "DEPLETED";
  await sourceLot.save();
  try {
    const targetLot = await InventoryLot.create({
      businessId,
      itemId: item._id,
      lotCode: reference("KLOT"),
      parentLotId: sourceLot._id,
      sourceType: "INTERNAL_TRANSFER",
      businessUnit: "KARENDERIYA",
      storageLocation: input.storageLocation,
      receivedDate: input.movementDate,
      initialQuantity: input.quantity,
      remainingQuantityCached: input.quantity,
      unitCost: unitCost.toString(),
      totalCost: unitCost.times(input.quantity).toString(),
    });
    const movement = await InventoryMovement.create({
      businessId,
      movementNumber: reference("XFER"),
      movementDate: input.movementDate,
      movementType: "TRANSFER",
      itemId: item._id,
      fromBusinessUnit: "PIGGERY",
      toBusinessUnit: "KARENDERIYA",
      fromLotId: sourceLot._id,
      toLotId: targetLot._id,
      quantity: input.quantity,
      unit: "KG",
      unitCostSnapshot: unitCost.toString(),
      totalCost: unitCost.times(input.quantity).toString(),
      reason: input.notes || "Internal meat transfer to karenderiya",
    });
    targetLot.sourceDocumentId = movement._id;
    await targetLot.save();
    return { movement, sourceLot, targetLot };
  } catch (error) {
    sourceLot.remainingQuantityCached = decimal(sourceLot.remainingQuantityCached?.toString())
      .plus(input.quantity)
      .toString() as any;
    sourceLot.status = "ACTIVE";
    await sourceLot.save();
    throw error;
  }
}

export async function postPiggerySale(businessId: Types.ObjectId, input: PiggerySaleInput) {
  const quantity = input.priceBasis === "PER_HEAD" ? input.headCount : input.weightKg;
  if (!quantity) throw new HttpError(422, "Enter the sale quantity for the selected price basis");
  const total = decimal(input.price).times(quantity);
  if (decimal(input.amountReceived).greaterThan(total))
    throw new HttpError(422, "Amount received cannot exceed the sale total");
  await requireCashAccount(businessId, input.receivingAccountId, input.amountReceived);

  let pig: InstanceType<typeof Pig> | null = null;
  let item: InstanceType<typeof InventoryItem> | null = null;
  let lot: InstanceType<typeof InventoryLot> | null = null;
  let cost = decimal(0);
  if (input.saleType === "LIVE_PIG") {
    pig = await Pig.findOne({ _id: input.pigId, businessId, status: "ACTIVE" });
    if (!pig) throw new HttpError(422, "Select an active pig to sell");
    cost = decimal(pig.accumulatedCostCached?.toString());
  } else {
    [item, lot] = await Promise.all([
      InventoryItem.findOne({ _id: input.inventoryItemId, businessId, isActive: true }),
      InventoryLot.findOne({
        _id: input.inventoryLotId,
        itemId: input.inventoryItemId,
        businessId,
        status: "ACTIVE",
      }),
    ]);
    if (!item || !lot) throw new HttpError(422, "Select an available meat inventory lot");
    if (
      !input.weightKg ||
      decimal(lot.remainingQuantityCached?.toString()).lessThan(input.weightKg)
    )
      throw new HttpError(422, "Sale quantity exceeds the available meat lot");
    cost = decimal(lot.unitCost?.toString()).times(input.weightKg);
  }
  const sale = await PiggerySale.create({
    businessId,
    saleNumber: reference("PS"),
    saleDate: input.saleDate,
    buyerId: input.buyerId,
    saleType: input.saleType,
    items: [
      {
        sourceType: input.saleType === "LIVE_PIG" ? "PIG" : "MEAT_LOT",
        pigId: pig?._id,
        inventoryItemId: item?._id,
        inventoryLotId: lot?._id,
        description: input.description,
        headCount: input.headCount,
        weightKg: input.weightKg,
        priceBasis: input.priceBasis,
        price: input.price,
        grossAmount: total.toString(),
        costSnapshot: cost.toString(),
        grossProfit: total.minus(cost).toString(),
      },
    ],
    subtotal: total.toString(),
    totalAmount: total.toString(),
    amountReceivedCached: input.amountReceived,
    balanceDueCached: total.minus(input.amountReceived).toString(),
    paymentStatus: decimal(input.amountReceived).isZero()
      ? "UNPAID"
      : decimal(input.amountReceived).equals(total)
        ? "PAID"
        : "PARTIALLY_PAID",
    receivingAccountId: input.receivingAccountId,
    notes: input.notes,
    status: "DRAFT",
  });
  try {
    if (pig) {
      pig.status = "SOLD";
      pig.statusDate = input.saleDate;
      await pig.save();
    }
    if (item && lot && input.weightKg) {
      lot.remainingQuantityCached = decimal(lot.remainingQuantityCached?.toString())
        .minus(input.weightKg)
        .toString() as any;
      if (decimal(lot.remainingQuantityCached?.toString()).isZero()) lot.status = "DEPLETED";
      await Promise.all([
        lot.save(),
        InventoryItem.updateOne(
          { _id: item._id, businessId },
          { $inc: { currentStockCached: -input.weightKg } },
        ),
        InventoryMovement.create({
          businessId,
          movementNumber: reference("SALE"),
          movementDate: input.saleDate,
          movementType: "SALE",
          itemId: item._id,
          fromBusinessUnit: lot.businessUnit,
          toBusinessUnit: "EXTERNAL",
          fromLotId: lot._id,
          quantity: input.weightKg,
          unit: item.baseUnit,
          unitCostSnapshot: lot.unitCost,
          totalCost: cost.toString(),
          source: { collection: "piggery_sales", documentId: sale._id },
          reason: input.description,
        }),
      ]);
    }
    if (input.amountReceived > 0) {
      const transaction = await postCash(
        businessId,
        {
          transactionDate: input.saleDate,
          businessUnit: "PIGGERY",
          transactionType: "CASH_IN",
          category: "SALE_COLLECTION",
          amount: input.amountReceived,
          accountId: input.receivingAccountId,
          description: `Piggery sale ${sale.saleNumber}`,
        },
        { collection: "piggery_sales", documentId: sale._id },
      );
      sale.cashTransactionId = transaction._id;
    }
    sale.status = "POSTED";
    await sale.save();
    return sale;
  } catch (error) {
    if (pig) {
      pig.status = "ACTIVE";
      pig.statusDate = undefined;
      await pig.save();
    }
    if (item && lot && input.weightKg) {
      lot.remainingQuantityCached = decimal(lot.remainingQuantityCached?.toString())
        .plus(input.weightKg)
        .toString() as any;
      lot.status = "ACTIVE";
      await Promise.all([
        lot.save(),
        InventoryItem.updateOne(
          { _id: item._id, businessId },
          { $inc: { currentStockCached: input.weightKg } },
        ),
        InventoryMovement.deleteMany({
          businessId,
          "source.collection": "piggery_sales",
          "source.documentId": sale._id,
        }),
      ]);
    }
    await sale.deleteOne();
    throw error;
  }
}

export async function postCookingBatch(businessId: Types.ObjectId, input: CookingBatchInput) {
  const menu = await MenuItem.findOne({
    _id: input.menuItemId,
    businessId,
    isActive: true,
  });
  if (!menu) throw new HttpError(404, "Menu item was not found");
  const recipe = await Recipe.findOne({ _id: menu.recipeId, businessId, isActive: true });
  if (!recipe?.ingredients.length)
    throw new HttpError(422, "Menu item needs a recipe with inventory ingredients");
  const recipeYield = decimal(recipe.yieldServings?.toString());
  if (!recipeYield.greaterThan(0))
    throw new HttpError(422, "Recipe yield must be greater than zero");
  const scale = decimal(input.actualServingsProduced).dividedBy(recipeYield);
  const itemIds = recipe.ingredients.map((ingredient: any) => ingredient.inventoryItemId);
  const items = await InventoryItem.find({
    _id: { $in: itemIds },
    businessId,
    isActive: true,
  });
  if (items.length !== itemIds.length)
    throw new HttpError(422, "One or more recipe ingredients are unavailable");
  const requirements = recipe.ingredients.map((ingredient: any) => {
    const item = items.find((candidate) => candidate.id === String(ingredient.inventoryItemId));
    const quantity = decimal(ingredient.quantity?.toString()).times(scale);
    if (!item || decimal(item.currentStockCached?.toString()).lessThan(quantity))
      throw new HttpError(422, `Not enough ${item?.name ?? "ingredient"} in inventory`);
    return { ingredient, item, quantity };
  });
  const batch = await CookingBatch.create({
    businessId,
    cookingBatchNumber: reference("COOK"),
    cookingDate: input.cookingDate,
    menuItemId: menu._id,
    recipeId: recipe._id,
    recipeVersion: recipe.version,
    plannedServings: input.actualServingsProduced,
    actualServingsProduced: input.actualServingsProduced,
    additionalCosts: input.additionalCosts,
    servingsSoldCached: 0,
    servingsComplimentary: 0,
    servingsWasted: 0,
    servingsRemainingCached: input.actualServingsProduced,
    notes: input.notes,
    status: "DRAFT",
  });
  const changed: Array<{ id: Types.ObjectId; quantity: string }> = [];
  const movements: Types.ObjectId[] = [];
  try {
    const usages = [];
    let ingredientTotal = decimal(0);
    for (const requirement of requirements) {
      const quantity = requirement.quantity.toString();
      const updated = await InventoryItem.findOneAndUpdate(
        {
          _id: requirement.item._id,
          businessId,
          currentStockCached: { $gte: quantity },
        },
        { $inc: { currentStockCached: requirement.quantity.negated().toString() } },
        { new: true },
      );
      if (!updated) throw new HttpError(422, `Not enough ${requirement.item.name} in inventory`);
      changed.push({ id: requirement.item._id, quantity });
      const unitCost = decimal(
        requirement.item.defaultKarenderiyaTransferPricePerUnit?.toString() ??
          requirement.item.defaultExternalPricePerUnit?.toString() ??
          0,
      );
      const totalCost = unitCost.times(requirement.quantity);
      ingredientTotal = ingredientTotal.plus(totalCost);
      const movement = await InventoryMovement.create({
        businessId,
        movementNumber: reference("CCON"),
        movementDate: input.cookingDate,
        movementType: "CONSUMPTION",
        itemId: requirement.item._id,
        fromBusinessUnit: "KARENDERIYA",
        quantity,
        unit: requirement.item.baseUnit,
        unitCostSnapshot: unitCost.toString(),
        totalCost: totalCost.toString(),
        allocations: [
          {
            targetType: "COOKING_BATCH",
            targetId: batch._id,
            quantity,
            allocatedCost: totalCost.toString(),
          },
        ],
        source: { collection: "cooking_batches", documentId: batch._id },
        reason: `Ingredients for ${batch.cookingBatchNumber}`,
      });
      movements.push(movement._id);
      usages.push({
        inventoryItemId: requirement.item._id,
        quantityUsed: quantity,
        unit: requirement.item.baseUnit,
        unitCostSnapshot: unitCost.toString(),
        totalCost: totalCost.toString(),
        inventoryMovementId: movement._id,
      });
    }
    const additionalTotal = input.additionalCosts.reduce(
      (total, cost) => total.plus(cost.amount),
      decimal(0),
    );
    const batchTotal = ingredientTotal.plus(additionalTotal);
    batch.ingredientUsages = usages as any;
    batch.totalIngredientCost = ingredientTotal.toString() as any;
    batch.totalAdditionalCost = additionalTotal.toString() as any;
    batch.totalBatchCost = batchTotal.toString() as any;
    batch.costPerServing = batchTotal.dividedBy(input.actualServingsProduced).toString() as any;
    batch.status = "COMPLETED";
    await batch.save();
    return batch;
  } catch (error) {
    for (const item of changed)
      await InventoryItem.updateOne(
        { _id: item.id, businessId },
        { $inc: { currentStockCached: item.quantity } },
      );
    await Promise.all([
      InventoryMovement.deleteMany({ _id: { $in: movements } }),
      batch.deleteOne(),
    ]);
    throw error;
  }
}
