import { describe, expect, it } from "vitest";
import { normalizeBusinessName } from "../src/lib/auth-utils.js";
import { addBusinessRole } from "../src/lib/business-roles.js";

describe("business identity and role ownership", () => {
  it("normalizes company names for uniqueness", () => {
    expect(normalizeBusinessName("  Miss   V Business ")).toBe("miss v business");
  });

  it("transfers Owner to a newly created higher role and renames the former role", () => {
    const result = addBusinessRole([{ level: 0, name: "Owner" }], 0, {
      level: 10,
      name: "Ignored for new owner",
      previousOwnerRoleName: "Administrator",
    });
    expect(result.ownerRole).toBe(10);
    expect(result.roles).toEqual([
      { level: 10, name: "Owner" },
      { level: 0, name: "Administrator" },
    ]);
    expect(result.transferred).toBe(true);
  });

  it("requires a former-owner role name before transferring ownership", () => {
    expect(() =>
      addBusinessRole([{ level: 0, name: "Owner" }], 0, { level: 1, name: "Owner" }),
    ).toThrow("Name the previous owner role");
  });

  it("reserves the Owner name for the highest numeric role", () => {
    expect(() =>
      addBusinessRole([{ level: 10, name: "Owner" }], 10, { level: 5, name: "Owner" }),
    ).toThrow("Only the highest role");
  });
});
