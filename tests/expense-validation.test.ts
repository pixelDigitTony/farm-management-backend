import { parse } from "valibot";
import { describe, expect, it } from "vitest";
import { expenseOperationSchema } from "../src/validation/operations.js";

describe("expense category validation", () => {
  it("accepts liability as an expense category", () => {
    const expense = parse(expenseOperationSchema, {
      expenseNumber: "EXP-001",
      expenseDate: "2026-08-30",
      businessUnit: "GENERAL",
      category: "LIABILITY",
      description: "Loan obligation payment",
      totalAmount: 1_000,
      amountPaid: 500,
      accountId: "cash-account-id",
    });

    expect(expense.category).toBe("LIABILITY");
  });
});
