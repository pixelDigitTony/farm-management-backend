import { parse } from "valibot";
import { describe, expect, it } from "vitest";
import { defaultLandingSections } from "../src/services/landing-page-template.js";
import { landingPageVariantUpdateSchema } from "../src/validation/landing-page.js";

function item(index: number, sourceType: "MENU_ITEM" | "PRODUCT" = "PRODUCT") {
  return {
    sourceId: String(index),
    sourceType,
    name: `Item ${index}`,
    isFeatured: false,
    isAvailable: true,
    mediaUrls: ["https://example.com/product.jpg"],
  };
}

describe("default landing-page template", () => {
  it("selects available items within limits, prioritizes featured products and uses existing media", () => {
    const sections = defaultLandingSections(
      { businessName: "Our shop", karenderiya: { address: "Market road" } },
      [
        ...Array.from({ length: 30 }, (_, index) => item(index)),
        ...Array.from({ length: 15 }, (_, index) => item(index + 100, "MENU_ITEM")),
        { ...item(99), isFeatured: true },
        { ...item(98), isAvailable: false },
      ],
    );
    const components = sections.flatMap((section) => section.components);
    const catalog = components.find((component) => component.type === "CATALOG");
    const menu = components.find((component) => component.type === "MENU");
    expect(catalog?.content.catalogItemRefs).toHaveLength(24);
    expect(catalog?.content.catalogItemRefs[0]?.sourceId).toBe("99");
    expect(catalog?.content.catalogItemRefs.some((reference) => reference.sourceId === "98")).toBe(
      false,
    );
    expect(catalog?.content.displayMode).toBe("HORIZONTAL");
    expect(menu?.content.menuItemIds).toHaveLength(12);
    expect(menu?.content.displayMode).toBe("VERTICAL");
    expect(components.find((component) => component.type === "GALLERY")?.content.mediaUrls).toEqual(
      ["https://example.com/product.jpg"],
    );
    expect(components.find((component) => component.type === "CONTACT")?.content.address).toBe(
      "Market road",
    );
    expect(components.find((component) => component.type === "HERO")?.content.primaryUrl).toBe(
      "#products",
    );
    const saved = parse(landingPageVariantUpdateSchema, {
      name: "Main",
      sections,
      theme: {
        primaryColor: "#be185d",
        backgroundColor: "#fff7fb",
        surfaceColor: "#ffffff",
        textColor: "#292524",
        fontStyle: "CLASSIC",
        buttonStyle: "ROUNDED",
      },
    });
    expect(saved.sections.filter((section) => section.maxHeight === 640)).toHaveLength(3);
    expect(saved.commerce.orderingEnabled).toBe(true);
  });

  it("handles empty and menu-only businesses without broken primary links or shared ids", () => {
    const empty = defaultLandingSections(null, []);
    expect(empty.some((section) => section.name === "Gallery")).toBe(false);
    expect(
      empty
        .filter((section) => section.name.startsWith("Featured"))
        .every((section) => section.enabled),
    ).toBe(true);
    const menuOnly = defaultLandingSections(null, [item(1, "MENU_ITEM")]);
    expect(menuOnly.find((section) => section.name === "Featured products")?.enabled).toBe(false);
    expect(
      menuOnly
        .flatMap((section) => section.components)
        .find((component) => component.type === "HERO")?.content.primaryUrl,
    ).toBe("#menu");
    const ids = [...empty, ...menuOnly].flatMap((section) => [
      section.id,
      ...section.components.map((component) => component.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
