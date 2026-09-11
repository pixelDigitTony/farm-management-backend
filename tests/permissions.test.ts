import { describe, expect, it } from "vitest";
import {
  allowsRequest,
  effectivePermissions,
  requiredPermissions,
} from "../src/lib/permissions.js";

describe("module permission policy", () => {
  it("distinguishes unconfigured legacy roles from explicit no-access roles", () => {
    expect(effectivePermissions({}, false)).toContain("inventory:delete");
    expect(effectivePermissions({}, false)).not.toContain("catalog:view");
    expect(effectivePermissions({ permissions: [] }, false)).toEqual([]);
    expect(effectivePermissions(undefined, false)).toEqual([]);
    expect(effectivePermissions({ permissions: [] }, true)).toContain("catalog:delete");
  });
  it("requires both module view and the requested action", () => {
    expect(allowsRequest(["inventory:view"], "/api/resources/inventory-items?limit=10")).toBe(true);
    expect(allowsRequest(["inventory:view"], "/api/operations/inventory-receipts", "POST")).toBe(
      false,
    );
    expect(allowsRequest(["inventory:create"], "/api/operations/inventory-receipts", "POST")).toBe(
      false,
    );
    expect(
      allowsRequest(
        ["inventory:view", "inventory:create"],
        "/api/operations/inventory-receipts",
        "POST",
      ),
    ).toBe(true);
    expect(
      allowsRequest(["inventory:view", "inventory:create"], "/api/resources/cash-accounts"),
    ).toBe(false);
  });
  it("classifies special actions and rejects unknown endpoints", () => {
    expect(requiredPermissions("/api/landing-page/variants/id/publish", "POST")).toEqual([
      "landing-page:edit",
    ]);
    expect(requiredPermissions("/api/landing-page/unpublish", "POST")).toEqual([
      "landing-page:edit",
    ]);
    expect(requiredPermissions("/api/calculations/slaughter", "POST")).toEqual(["slaughter:view"]);
    expect(requiredPermissions("/api/settings/slaughter")).toEqual([
      "slaughter:view",
      "settings:view",
    ]);
    expect(requiredPermissions("/api/orders/id/status", "PATCH")).toEqual(["orders:edit"]);
    expect(allowsRequest(["inventory:view"], "/api/resources/not-a-resource")).toBe(false);
    expect(allowsRequest(["inventory:view"], "/api/new-private-module")).toBe(false);
  });
});
