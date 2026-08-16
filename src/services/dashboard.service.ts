import { startOfMonth } from "date-fns";
import type { Types } from "mongoose";
import {
  CashAccount,
  CashTransaction,
  Expense,
  InventoryItem,
  KarenderiyaSale,
  MenuItem,
  Pig,
  PiggerySale,
} from "../models/index.js";

const sum = (rows: Array<{ total?: unknown }>) => rows[0]?.total?.toString() ?? "0";

export async function getDashboard(businessId: Types.ObjectId) {
  const monthStart = startOfMonth(new Date());
  const [
    accounts,
    activePigs,
    slaughteredPigs,
    receivables,
    payables,
    monthCashIn,
    monthCashOut,
    piggerySales,
    karenderiyaSales,
    piggeryExpenses,
    karenderiyaExpenses,
    lowStock,
    menuItems,
    recentTransactions,
  ] = await Promise.all([
    CashAccount.find({ businessId, isActive: true }).sort({ accountType: 1 }).lean(),
    Pig.countDocuments({ businessId, status: "ACTIVE" }),
    Pig.countDocuments({ businessId, status: "SLAUGHTERED" }),
    PiggerySale.aggregate([
      { $match: { businessId, status: "POSTED" } },
      { $group: { _id: null, total: { $sum: "$balanceDueCached" } } },
    ]),
    Expense.aggregate([
      { $match: { businessId, status: "POSTED" } },
      { $group: { _id: null, total: { $sum: "$balanceDueCached" } } },
    ]),
    CashTransaction.aggregate([
      {
        $match: {
          businessId,
          status: "POSTED",
          transactionType: "CASH_IN",
          transactionDate: { $gte: monthStart },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    CashTransaction.aggregate([
      {
        $match: {
          businessId,
          status: "POSTED",
          transactionType: "CASH_OUT",
          transactionDate: { $gte: monthStart },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    PiggerySale.aggregate([
      { $match: { businessId, status: "POSTED", saleDate: { $gte: monthStart } } },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$totalAmount" },
          profit: { $sum: { $subtract: ["$totalAmount", { $sum: "$items.costSnapshot" }] } },
        },
      },
    ]),
    KarenderiyaSale.aggregate([
      { $match: { businessId, status: "POSTED", salesDate: { $gte: monthStart } } },
      { $group: { _id: null, revenue: { $sum: "$netSales" }, profit: { $sum: "$grossProfit" } } },
    ]),
    Expense.aggregate([
      {
        $match: {
          businessId,
          businessUnit: "PIGGERY",
          status: "POSTED",
          expenseDate: { $gte: monthStart },
        },
      },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Expense.aggregate([
      {
        $match: {
          businessId,
          businessUnit: "KARENDERIYA",
          status: "POSTED",
          expenseDate: { $gte: monthStart },
        },
      },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    InventoryItem.find({
      businessId,
      isActive: true,
      $expr: { $lte: ["$currentStockCached", "$lowStockLevel"] },
    })
      .limit(8)
      .lean(),
    MenuItem.find({ businessId, isActive: true }).sort({ name: 1 }).limit(8).lean(),
    CashTransaction.find({ businessId, status: "POSTED" })
      .sort({ transactionDate: -1 })
      .limit(6)
      .lean(),
  ]);

  return {
    accounts,
    metrics: {
      activePigs,
      slaughteredPigs,
      receivables: sum(receivables),
      payables: sum(payables),
      monthCashIn: sum(monthCashIn),
      monthCashOut: sum(monthCashOut),
      netCashFlow: (Number(sum(monthCashIn)) - Number(sum(monthCashOut))).toFixed(2),
      piggeryRevenue: piggerySales[0]?.revenue?.toString() ?? "0",
      piggeryProfit: piggerySales[0]?.profit?.toString() ?? "0",
      karenderiyaRevenue: karenderiyaSales[0]?.revenue?.toString() ?? "0",
      karenderiyaProfit: karenderiyaSales[0]?.profit?.toString() ?? "0",
      piggeryExpenses: sum(piggeryExpenses),
      karenderiyaExpenses: sum(karenderiyaExpenses),
    },
    lowStock,
    menuItems,
    recentTransactions,
  };
}
