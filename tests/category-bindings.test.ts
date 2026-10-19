import { describe, expect, it } from "vitest";
import { filterPublishedCatalogItems } from "../src/services/commerce.service.js";

describe("published category collection exposure", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({
    sourceType: i === 59 ? "MENU_ITEM" : "PRODUCT",
    sourceId: String(i),
    categoryId: i < 40 ? "bakery" : "meat",
  }));
  const snapshot = (binding: any, type = "CATALOG") => ({
    schemaVersion: 2,
    sections: [
      {
        enabled: true,
        components: [{ type, enabled: true, content: { categoryBinding: binding } }],
      },
    ],
  });
  it("includes entire categories beyond legacy item limits and picks up new products", () => {
    const doc = snapshot({ mode: "SELECTED_CATEGORIES", categoryIds: ["bakery"] });
    expect(filterPublishedCatalogItems(doc, items)).toHaveLength(40);
    expect(
      filterPublishedCatalogItems(doc, [
        ...items,
        { sourceType: "PRODUCT", sourceId: "new", categoryId: "bakery" },
      ]),
    ).toHaveLength(41);
  });
  it("distinguishes an empty selection from all categories and enforces menu source", () => {
    expect(
      filterPublishedCatalogItems(
        snapshot({ mode: "SELECTED_CATEGORIES", categoryIds: [] }),
        items,
      ),
    ).toEqual([]);
    expect(filterPublishedCatalogItems(snapshot({ mode: "ALL_CATEGORIES" }), items)).toHaveLength(
      60,
    );
    expect(
      filterPublishedCatalogItems(snapshot({ mode: "ALL_CATEGORIES" }, "MENU"), items),
    ).toEqual([items[59]]);
  });
  it("does not expose hidden blocks and preserves old selected item snapshots", () => {
    const doc = snapshot({ mode: "ALL_CATEGORIES" });
    doc.sections[0]!.enabled = false;
    expect(filterPublishedCatalogItems(doc, items)).toEqual([]);
    expect(
      filterPublishedCatalogItems(
        {
          schemaVersion: 2,
          sections: [
            {
              enabled: true,
              components: [
                {
                  type: "CATALOG",
                  enabled: true,
                  content: { catalogItemRefs: [{ sourceType: "PRODUCT", sourceId: "4" }] },
                },
              ],
            },
          ],
        },
        items,
      ),
    ).toEqual([items[4]]);
  });
});
