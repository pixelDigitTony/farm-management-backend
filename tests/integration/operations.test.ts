import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mongoJsonReplacer } from "../../src/lib/json.js";
import { errorHandler } from "../../src/middleware/errors.js";
import {
  CashAccount,
  CashTransaction,
  Contact,
  Expense,
  InventoryItem,
  InventoryLot,
  InventoryMovement,
  MenuItem,
  Pig,
  PigBatch,
  PigMeasurement,
  Recipe,
} from "../../src/models/index.js";
import { resourceRouter } from "../../src/routes/resource.routes.js";
import {
  postInventoryReceipt,
  postMeatTransfer,
  updateInventoryReceipt,
} from "../../src/services/farm-operations.service.js";
import { deleteExpense, postCash } from "../../src/services/posting.service.js";
import { startTestDatabase } from "./database.js";

const businessId = new mongoose.Types.ObjectId();
const otherBusinessId = new mongoose.Types.ObjectId();
const app = express();
app.set("json replacer", mongoJsonReplacer);
app.use(express.json());
// This suite exercises the resource boundary; auth itself has a separate suite.
app.use((req, _res, next) => {
  req.owner = {
    businessId,
    userId: new mongoose.Types.ObjectId(),
    sessionId: new mongoose.Types.ObjectId(),
    role: 0,
    status: "ACTIVE",
    isApproved: true,
    emailVerified: true,
  };
  next();
});
app.use("/resources", resourceRouter);
app.use(errorHandler);
let stop: (() => Promise<void>) | undefined;
beforeAll(async () => {
  stop = await startTestDatabase();
});
afterAll(async () => {
  await stop?.();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  if (!mongoose.connection.name.startsWith("farm_test_")) throw new Error("Unsafe test database");
  for (const model of Object.values(mongoose.models)) await model.deleteMany({});
});

async function seed() {
  const account = await CashAccount.create({
    businessId,
    accountCode: "CASH",
    name: "Cash",
    accountType: "CASH",
    openingBalance: "10000",
    currentBalanceCached: "10000",
  });
  const item = await InventoryItem.create({
    businessId,
    itemCode: "FEED",
    name: "Feed",
    category: "FEED",
    baseUnit: "KG",
    businessUnit: "PIGGERY",
  });
  return { account, item };
}
const receipt = (itemId: string, accountId: string) => ({
  itemId,
  accountId,
  movementDate: new Date("2026-09-01T00:00:00Z"),
  businessUnit: "PIGGERY" as const,
  purchaseQuantity: 2,
  measurementPerPurchaseUnit: 50,
  totalPurchaseCost: 4000,
  amountPaid: 1500,
});

describe("transactional inventory and cash", () => {
  it("commits all receipt postings, then corrects them without duplicate cash effects", async () => {
    const { item, account } = await seed();
    const result = await postInventoryReceipt(businessId, receipt(item.id, account.id));
    expect((await InventoryItem.findById(item.id))?.currentStockCached.toString()).toBe("100");
    expect((await CashAccount.findById(account.id))?.currentBalanceCached.toString()).toBe("8500");
    expect(await CashTransaction.countDocuments({ status: "POSTED" })).toBe(1);
    await updateInventoryReceipt(businessId, result.lot.id, {
      ...receipt(item.id, account.id),
      purchaseQuantity: 3,
      totalPurchaseCost: 6000,
      amountPaid: 2000,
    });
    expect((await InventoryItem.findById(item.id))?.currentStockCached.toString()).toBe("150");
    expect((await InventoryLot.findById(result.lot.id))?.remainingQuantityCached.toString()).toBe(
      "150",
    );
    expect((await CashAccount.findById(account.id))?.currentBalanceCached.toString()).toBe("8000");
    expect(await CashTransaction.countDocuments({ status: "POSTED" })).toBe(1);
    expect(await Expense.countDocuments()).toBe(1);
  });

  it("rolls back a lot if creating its movement fails", async () => {
    const { item, account } = await seed();
    vi.spyOn(InventoryMovement, "create").mockRejectedValueOnce(
      new Error("injected movement failure"),
    );
    await expect(postInventoryReceipt(businessId, receipt(item.id, account.id))).rejects.toThrow(
      "injected",
    );
    expect(await InventoryLot.countDocuments()).toBe(0);
    expect(await Expense.countDocuments()).toBe(0);
    expect((await InventoryItem.findById(item.id))?.currentStockCached.toString()).toBe("0");
  });

  it("rolls back stock, expense, and cash when final receipt linking fails", async () => {
    const { item, account } = await seed();
    vi.spyOn(InventoryMovement.prototype, "save").mockImplementationOnce(async () => {
      throw new Error("injected final save failure");
    });
    await expect(postInventoryReceipt(businessId, receipt(item.id, account.id))).rejects.toThrow(
      "injected",
    );
    expect(await InventoryLot.countDocuments()).toBe(0);
    expect(await Expense.countDocuments()).toBe(0);
    expect(await CashTransaction.countDocuments()).toBe(0);
    expect((await CashAccount.findById(account.id))?.currentBalanceCached.toString()).toBe("10000");
  });

  it("rejects a foreign payment account without leaving inventory records", async () => {
    const { item } = await seed();
    const foreign = await CashAccount.create({
      businessId: otherBusinessId,
      accountCode: "OTHER",
      name: "Other",
      accountType: "CASH",
    });
    await expect(postInventoryReceipt(businessId, receipt(item.id, foreign.id))).rejects.toThrow(
      "Cash account",
    );
    expect(await InventoryLot.countDocuments()).toBe(0);
  });

  it("allows only one of two transfers exceeding the available stock", async () => {
    const { item } = await seed();
    item.category = "MEAT";
    item.currentStockCached = "10";
    await item.save();
    const lot = await InventoryLot.create({
      businessId,
      itemId: item.id,
      lotCode: "MEAT",
      sourceType: "SLAUGHTER",
      businessUnit: "PIGGERY",
      receivedDate: new Date(),
      initialQuantity: "10",
      remainingQuantityCached: "10",
      unitCost: "100",
    });
    const input = {
      inventoryItemId: item.id,
      sourceLotId: lot.id,
      quantity: 7,
      movementDate: new Date(),
    };
    const results = await Promise.allSettled([
      postMeatTransfer(businessId, input),
      postMeatTransfer(businessId, input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lots = await InventoryLot.find();
    expect(lots.reduce((sum, row) => sum + Number(row.remainingQuantityCached.toString()), 0)).toBe(
      10,
    );
    expect(await CashTransaction.countDocuments()).toBe(0);
    expect(await Expense.countDocuments()).toBe(0);
  });

  it("keeps a cash transfer balanced and rejects same-account transfers", async () => {
    const { account } = await seed();
    const destination = await CashAccount.create({
      businessId,
      accountCode: "BANK",
      name: "Bank",
      accountType: "BANK",
    });
    const input = {
      transactionDate: new Date(),
      businessUnit: "GENERAL" as const,
      transactionType: "TRANSFER" as const,
      category: "ACCOUNT_TRANSFER" as const,
      amount: 123.45,
      fromAccountId: account.id,
      toAccountId: destination.id,
      description: "Move cash",
    };
    await postCash(businessId, input);
    expect(Number((await CashAccount.findById(account.id))?.currentBalanceCached)).toBe(9876.55);
    expect(Number((await CashAccount.findById(destination.id))?.currentBalanceCached)).toBe(123.45);
    await expect(postCash(businessId, { ...input, toAccountId: account.id })).rejects.toThrow(
      "different",
    );
    expect(await CashTransaction.countDocuments()).toBe(1);
  });

  it("reverses a standalone expense once under concurrent deletion", async () => {
    const { account } = await seed();
    const { postExpense } = await import("../../src/services/posting.service.js");
    const expense = await postExpense(businessId, {
      expenseNumber: "EXP-1",
      expenseDate: new Date(),
      businessUnit: "GENERAL",
      category: "OTHER",
      description: "Expense",
      totalAmount: 100,
      amountPaid: 100,
      accountId: account.id,
    });
    const results = await Promise.allSettled([
      deleteExpense(businessId, expense.id),
      deleteExpense(businessId, expense.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(Number((await CashAccount.findById(account.id))?.currentBalanceCached)).toBe(10000);
  });
});

describe("tenant-safe resource API", () => {
  it("scopes source contacts on batch creation and pig updates", async () => {
    const own = await Contact.create({
      businessId,
      contactCode: "OWN",
      name: "Own supplier",
      types: ["SUPPLIER"],
    });
    const foreign = await Contact.create({
      businessId: otherBusinessId,
      contactCode: "OTHER",
      name: "Other supplier",
      types: ["SUPPLIER"],
    });
    await request(app)
      .post("/resources/pig-batches")
      .send({ batchCode: "NEW", name: "New", sourceContactId: foreign.id })
      .expect(422);
    expect(await PigBatch.countDocuments()).toBe(0);
    const batch = await request(app)
      .post("/resources/pig-batches")
      .send({ batchCode: "NEW", name: "New", sourceContactId: own.id })
      .expect(201);
    await request(app)
      .patch(`/resources/pig-batches/${batch.body.id}`)
      .send({ sourceContactId: foreign.id })
      .expect(422);
    const pig = await Pig.create({ businessId, pigCode: "OWN" });
    await request(app)
      .patch(`/resources/pigs/${pig.id}`)
      .send({ sourceContactId: foreign.id })
      .expect(422);
    await request(app)
      .patch(`/resources/pigs/${pig.id}`)
      .send({ sourceContactId: own.id })
      .expect(200);
    expect(String((await Pig.findById(pig.id))?.sourceContactId)).toBe(own.id);
  });
  it("rejects foreign and missing recipe references without changing a menu item", async () => {
    const own = await Recipe.create({ businessId, recipeCode: "OWN", name: "Own recipe" });
    const foreign = await Recipe.create({
      businessId: otherBusinessId,
      recipeCode: "OTHER",
      name: "Other recipe",
    });
    const menu = await MenuItem.create({
      businessId,
      menuCode: "MENU",
      name: "Original",
      recipeId: own.id,
    });
    for (const recipeId of [foreign.id, new mongoose.Types.ObjectId().toHexString(), "invalid"]) {
      await request(app)
        .patch(`/resources/menu-items/${menu.id}`)
        .send({ name: "Changed", recipeId })
        .expect(422);
    }
    expect((await MenuItem.findById(menu.id))?.name).toBe("Original");
    await request(app)
      .post("/resources/menu-items")
      .send({ menuCode: "NEW", name: "New", recipeId: foreign.id })
      .expect(422);
    expect(await MenuItem.countDocuments()).toBe(1);
    await request(app)
      .patch(`/resources/menu-items/${menu.id}`)
      .send({ recipeId: own.id, name: "Valid change" })
      .expect(200);
  });

  it("checks every recipe ingredient and accepts repeated references to an owned item", async () => {
    const { item } = await seed();
    const foreign = await InventoryItem.create({
      businessId: otherBusinessId,
      itemCode: "OTHER",
      name: "Other",
      category: "FEED",
      baseUnit: "KG",
      businessUnit: "PIGGERY",
    });
    for (const ingredients of [
      [{ inventoryItemId: item.id }, { inventoryItemId: foreign.id }],
      [{}],
      [null],
      null,
    ]) {
      await request(app)
        .post("/resources/recipes")
        .send({ recipeCode: "NEW", name: "Recipe", ingredients })
        .expect(422);
    }
    expect(await Recipe.countDocuments()).toBe(0);
    const result = await request(app)
      .post("/resources/recipes")
      .send({
        recipeCode: "NEW",
        name: "Recipe",
        ingredients: [{ inventoryItemId: item.id }, { inventoryItemId: item.id.toUpperCase() }],
      })
      .expect(201);
    await request(app)
      .patch(`/resources/recipes/${result.body.id}`)
      .send({ ingredients: [{ inventoryItemId: foreign.id }] })
      .expect(422);
    expect((await Recipe.findById(result.body.id))?.ingredients).toHaveLength(2);
    await request(app)
      .patch(`/resources/recipes/${result.body.id}`)
      .send({ name: "Rename only" })
      .expect(200);
    await request(app)
      .patch(`/resources/recipes/${result.body.id}`)
      .send({ ingredients: [] })
      .expect(200);
  });

  it("rejects foreign measurement targets and pig batch changes", async () => {
    const batch = await PigBatch.create({
      businessId: otherBusinessId,
      batchCode: "OTHER",
      name: "Other",
    });
    const foreign = await Pig.create({ businessId: otherBusinessId, pigCode: "OTHER" });
    const own = await Pig.create({ businessId, pigCode: "OWN" });
    await request(app).patch(`/resources/pigs/${own.id}`).send({ batchId: batch.id }).expect(422);
    for (const target of [{ pigId: foreign.id }, { batchId: batch.id }]) {
      await request(app)
        .post("/resources/pig-measurements")
        .send({ measurementDate: "2026-09-01", measurementType: "INDIVIDUAL", ...target })
        .expect(422);
    }
    expect(await PigMeasurement.countDocuments()).toBe(0);
    await request(app).patch(`/resources/pigs/${own.id}`).send({ batchId: null }).expect(200);
    const result = await request(app)
      .post("/resources/pig-measurements")
      .send({ measurementDate: "2026-09-01", measurementType: "INDIVIDUAL", pigId: own.id })
      .expect(201);
    await request(app)
      .patch(`/resources/pig-measurements/${result.body.id}`)
      .send({ pigId: foreign.id })
      .expect(422);
    expect(String((await PigMeasurement.findById(result.body.id))?.pigId)).toBe(own.id);
  });
  it("isolates reads, refuses filter overrides, and prevents operator updates", async () => {
    const { item } = await seed();
    const foreign = await InventoryItem.create({
      businessId: otherBusinessId,
      itemCode: "OTHER",
      name: "Other",
      category: "FEED",
      baseUnit: "KG",
      businessUnit: "PIGGERY",
    });
    const list = await request(app).get("/resources/inventory-items").expect(200);
    expect(list.body.items.map((row: { _id: string }) => row._id)).toEqual([item.id]);
    await request(app).get(`/resources/inventory-items?businessId=${otherBusinessId}`).expect(422);
    await request(app).get(`/resources/inventory-items/${foreign.id}`).expect(404);
    await request(app)
      .patch(`/resources/inventory-items/${item.id}`)
      .send({ $set: { currentStockCached: 999, businessId: otherBusinessId } })
      .expect(422);
    expect(Number((await InventoryItem.findById(item.id))?.currentStockCached)).toBe(0);
  });
  it("derives opening balance and refuses later direct balance edits", async () => {
    const response = await request(app)
      .post("/resources/cash-accounts")
      .send({
        accountCode: "CASH",
        name: "Cash",
        accountType: "CASH",
        openingBalance: 50,
        currentBalanceCached: 999,
      })
      .expect(201);
    expect(Number(response.body.currentBalanceCached)).toBe(50);
    await request(app)
      .patch(`/resources/cash-accounts/${response.body.id}`)
      .send({ currentBalanceCached: 999 })
      .expect(409);
  });
});
