import { describe, expect, it } from "vitest";
import { accountState, getBusinessScopedModels } from "../src/routes/admin.routes.js";

const business = {
  _id: "business-id",
  businessName: "Test Business",
};

const owner = {
  _id: "owner-id",
  name: "Owner",
  email: "owner@example.com",
  phone: "+639171234567",
  role: 0,
  status: "ACTIVE",
  isActive: true,
  isApproved: true,
  emailVerifiedAt: new Date(),
};

describe("admin owner account lifecycle", () => {
  it("prioritizes protected and archived account states", () => {
    expect(accountState({ ...owner, role: 99 }, { ...business, isArchived: true })).toBe(
      "SUPER_ADMIN",
    );
    expect(accountState(owner, { ...business, isArchived: true })).toBe("ARCHIVED");
  });

  it("distinguishes verification, approval, disabled, locked, and active states", () => {
    expect(accountState({ ...owner, emailVerifiedAt: null }, business)).toBe("PENDING_EMAIL");
    expect(accountState({ ...owner, isApproved: false }, business)).toBe("PENDING_APPROVAL");
    expect(accountState({ ...owner, isActive: false }, business)).toBe("DISABLED");
    expect(accountState({ ...owner, status: "LOCKED" }, business)).toBe("LOCKED");
    expect(accountState(owner, business)).toBe("ACTIVE");
  });

  it("includes all business-owned collections in permanent deletion", () => {
    const names = getBusinessScopedModels().map((model) => model.modelName);
    expect(names).toEqual(
      expect.arrayContaining([
        "User",
        "AuthSession",
        "RegistrationInvite",
        "AuditLog",
        "CashAccount",
        "CashTransaction",
        "Expense",
        "InventoryItem",
        "InventoryLot",
        "InventoryMovement",
        "Pig",
        "SlaughterRecord",
        "PiggerySale",
        "Recipe",
        "CookingBatch",
        "KarenderiyaSale",
        "LandingPage",
        "LandingPageVariant",
      ]),
    );
    expect(names).not.toContain("Business");
    expect(names).not.toContain("EmailVerificationToken");
  });
});
