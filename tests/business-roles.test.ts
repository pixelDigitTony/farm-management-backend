import { describe, expect, it } from "vitest";
import { normalizeBusinessName } from "../src/lib/auth-utils.js";
import { addBusinessRole } from "../src/lib/business-roles.js";

describe("business role names", () => {
  it("normalizes company names for uniqueness", () => {
    expect(normalizeBusinessName("  Miss   V Business ")).toBe("miss v business");
  });
  it("uses the supplied higher-role name without renaming existing roles", () => {
    const roles = [{ level: 1, name: "Owner" }];
    const result = addBusinessRole(roles, 1, { level: 10, name: "Director" });
    expect(result).toEqual({
      ownerRole: 10,
      transferred: true,
      roles: [
        { level: 10, name: "Director" },
        { level: 1, name: "Owner" },
      ],
    });
    expect(roles).toEqual([{ level: 1, name: "Owner" }]);
  });
  it("retains ownership when adding a lower role", () => {
    expect(
      addBusinessRole([{ level: 10, name: "Director" }], 10, { level: 2, name: "Manager" }),
    ).toMatchObject({ ownerRole: 10, transferred: false });
  });
  it("rejects duplicate numeric levels", () => {
    expect(() =>
      addBusinessRole([{ level: 1, name: "Owner" }], 1, { level: 1, name: "Manager" }),
    ).toThrow("already exists");
  });
});
