import { describe, expect, it } from "vitest";
import { normalizeBusinessName } from "../src/lib/auth-utils.js";
import { addBusinessRole, editBusinessRole } from "../src/lib/business-roles.js";

const roles = [
  { level: 5, name: "Owner" },
  { level: 1, name: "Staff", permissions: ["inventory:view"] },
];
describe("role hierarchy", () => {
  it("normalizes company names for uniqueness", () => {
    expect(normalizeBusinessName("  Miss   V Business ")).toBe("miss v business");
  });
  it("moves the existing owner above a new role and preserves identities", () => {
    expect(addBusinessRole(roles, 5, { level: 5, name: "Manager" })).toEqual({
      ownerRole: 6,
      roles: [
        { level: 6, name: "Owner" },
        { level: 5, name: "Manager", permissions: [] },
        roles[1],
      ],
      changes: [{ from: 5, to: 6 }],
    });
    expect(roles[0]?.level).toBe(5);
  });
  it("reserves 98 for the owner and 99 for super admin", () => {
    expect(addBusinessRole(roles, 5, { level: 97, name: "Director" }).ownerRole).toBe(98);
    for (const level of [98, 99, -1, 1.5])
      expect(() => addBusinessRole(roles, 5, { level, name: "Invalid" })).toThrow();
  });
  it("keeps an existing higher owner when adding a lower role", () => {
    expect(addBusinessRole(roles, 5, { level: 2, name: "Assistant" }).ownerRole).toBe(5);
  });
  it("rejects duplicate non-owner levels", () => {
    expect(() => addBusinessRole(roles, 5, { level: 1, name: "Duplicate" })).toThrow(
      "already exists",
    );
  });
  it("moves a regular role into the old owner level without losing its permissions", () => {
    const result = editBusinessRole(roles, 5, 1, { level: 5, name: "Manager" });
    expect(result.roles).toEqual([
      { level: 6, name: "Owner" },
      { level: 5, name: "Manager", permissions: ["inventory:view"] },
    ]);
    expect(result.changes).toEqual([
      { from: 1, to: 5 },
      { from: 5, to: 6 },
    ]);
  });
  it("allows changing the owner only to one above the next highest role", () => {
    expect(editBusinessRole(roles, 5, 5, { level: 2, name: "Owner" }).ownerRole).toBe(2);
    for (const level of [1, 3, 98, 99])
      expect(() => editBusinessRole(roles, 5, 5, { level, name: "Owner" })).toThrow();
    expect(editBusinessRole(roles, 5, 5, { name: "Business owner" }).ownerRole).toBe(5);
  });
});

it("creates roles with no permissions even when permissions are supplied", () => {
  for (const permissions of [undefined, ["inventory:view", "inventory:create"]]) {
    const result = addBusinessRole(roles, 5, { level: 2, name: "New role", permissions });
    expect(result.roles.find((role) => role.level === 2)?.permissions).toEqual([]);
    expect(result.roles.find((role) => role.level === 1)?.permissions).toEqual(["inventory:view"]);
  }
});
