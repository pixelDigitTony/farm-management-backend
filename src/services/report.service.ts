import type { Types } from "mongoose";
import {
  CashTransaction,
  Expense,
  InventoryItem,
  KarenderiyaSale,
  MenuItem,
  Pig,
  PiggerySale,
  SlaughterRecord,
} from "../models/index.js";

export async function getReports(businessId: Types.ObjectId, range: { from: Date; to: Date }) {
  const date = { $gte: range.from, $lte: range.to };
  const [
    cashByUnit,
    expensesByUnit,
    expensesByCategory,
    pigCosts,
    slaughterYields,
    menuPerformance,
    piggerySales,
    inventory,
  ] = await Promise.all([
    CashTransaction.aggregate([
      { $match: { businessId, status: "POSTED", transactionDate: date } },
      {
        $group: {
          _id: { businessUnit: "$businessUnit", transactionType: "$transactionType" },
          amount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.businessUnit": 1, "_id.transactionType": 1 } },
    ]),
    Expense.aggregate([
      { $match: { businessId, status: "POSTED", expenseDate: date } },
      {
        $group: {
          _id: "$businessUnit",
          total: { $sum: "$totalAmount" },
          paid: { $sum: "$amountPaidCached" },
          payable: { $sum: "$balanceDueCached" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Expense.aggregate([
      { $match: { businessId, status: "POSTED", expenseDate: date } },
      { $group: { _id: "$category", total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]),
    Pig.find({ businessId })
      .sort({ accumulatedCostCached: -1 })
      .select("pigCode status latestWeightKgCached accumulatedCostCached")
      .lean(),
    SlaughterRecord.find({ businessId, status: "COMPLETED", slaughterDate: date })
      .sort({ slaughterDate: -1 })
      .select(
        "slaughterNumber slaughterDate liveWeightKg wholeCarcassWeightKg usablePartsWeightKg dressingPercentage usableYieldPercentage averageUsableMeatCostPerKg totalPigAndSlaughterCost",
      )
      .lean(),
    KarenderiyaSale.aggregate([
      { $match: { businessId, status: "POSTED", salesDate: date } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.menuItemId",
          menuName: { $first: "$items.menuNameSnapshot" },
          quantitySold: { $sum: "$items.quantitySold" },
          netSales: { $sum: "$items.netAmount" },
          totalCost: { $sum: "$items.totalCost" },
          grossProfit: { $sum: "$items.grossProfit" },
        },
      },
      { $sort: { netSales: -1 } },
    ]),
    PiggerySale.aggregate([
      { $match: { businessId, status: "POSTED", saleDate: date } },
      {
        $group: {
          _id: "$saleType",
          revenue: { $sum: "$totalAmount" },
          received: { $sum: "$amountReceivedCached" },
          receivable: { $sum: "$balanceDueCached" },
          count: { $sum: 1 },
        },
      },
    ]),
    InventoryItem.find({ businessId, isActive: true })
      .sort({ businessUnit: 1, category: 1, name: 1 })
      .select(
        "name businessUnit category baseUnit currentStockCached defaultExternalPricePerUnit defaultKarenderiyaTransferPricePerUnit",
      )
      .lean(),
  ]);
  return {
    range,
    cashByUnit,
    expensesByUnit,
    expensesByCategory,
    pigCosts,
    slaughterYields,
    menuPerformance,
    piggerySales,
    inventory,
    menuCount: await MenuItem.countDocuments({ businessId, isActive: true }),
  };
}
