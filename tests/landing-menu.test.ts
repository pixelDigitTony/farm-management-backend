import { Types } from "mongoose";
import { parse } from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogProduct, MenuItem } from "../src/models/index.js";
import { getLandingMenuItems, getPublishedCatalogItems } from "../src/services/commerce.service.js";
import { menuRecipeOperationSchema } from "../src/validation/operations.js";

afterEach(() => vi.restoreAllMocks());
describe("automatic landing menu", () => {
  it("validates independent visibility without changing legacy update inputs", () => {
    const schema = menuRecipeOperationSchema.entries.menu.entries.showOnLandingPage;
    expect(parse(schema, false)).toBe(false);
    expect(parse(schema, true)).toBe(true);
    expect(parse(schema, undefined)).toBeUndefined();
    expect(() => parse(schema, "false")).toThrow();
  });
  it("filters hidden and inactive menus while preserving unavailable and legacy-visible items", async () => {
    const businessId = new Types.ObjectId();
    const menu = {
      _id: new Types.ObjectId(),
      name: "Soup",
      sellingPricePerServing: "50",
      isAvailable: false,
    };
    const query = {
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([menu]),
    };
    const find = vi.spyOn(MenuItem, "find").mockReturnValue(query as never);
    const productFind = vi.spyOn(CatalogProduct, "find").mockImplementation(() => {
      throw new Error("Menu-only pages must not query products");
    });
    await getLandingMenuItems(businessId);
    expect(find).toHaveBeenCalledWith({
      businessId,
      isActive: true,
      showOnLandingPage: { $ne: false },
    });
    const result = await getPublishedCatalogItems(businessId, {
      components: [{ type: "MENU", content: { menuItemIds: [] } }],
    });
    expect(result).toEqual([
      expect.objectContaining({
        sourceType: "MENU_ITEM",
        sourceId: String(menu._id),
        isAvailable: false,
      }),
    ]);
    expect(productFind).not.toHaveBeenCalled();
    find.mockClear();
    expect(
      await getPublishedCatalogItems(businessId, {
        sections: [{ enabled: false, components: [{ type: "MENU" }] }],
      }),
    ).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
