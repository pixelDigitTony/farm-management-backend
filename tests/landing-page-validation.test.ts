import { parse } from "valibot";
import { describe, expect, it } from "vitest";
import {
  landingPageComponentSchema,
  landingPageSectionSchema,
  landingPageSettingsSchema,
  landingPageVariantUpdateSchema,
} from "../src/validation/landing-page.js";

function variant() {
  return {
    name: "Main",
    theme: {
      primaryColor: "#be185d",
      backgroundColor: "#fff7fb",
      surfaceColor: "#ffffff",
      textColor: "#292524",
      fontStyle: "CLASSIC",
      buttonStyle: "ROUNDED",
    },
    sections: [
      {
        id: "welcome-section",
        name: "Welcome",
        enabled: true,
        backgroundColor: "",
        textColor: "",
        contentWidth: "WIDE",
        padding: "LARGE",
        gap: "MEDIUM",
        components: [
          {
            id: "hero-1",
            type: "HERO",
            enabled: true,
            width: "TWO_THIRDS",
            content: {
              eyebrow: "Welcome",
              title: "Miss V Business",
              body: "From our farm to your table.",
              mediaUrl: "https://example.com/hero.jpg",
              primaryLabel: "View menu",
              primaryUrl: "#menu",
              secondaryLabel: "Call",
              secondaryUrl: "tel:+639171234567",
            },
          },
        ],
      },
    ],
  };
}

describe("landing-page validation", () => {
  it("preserves scroll settings and defaults older sections to unlimited height and catalogs to horizontal rows", () => {
    const section = {
      ...variant().sections[0],
      maxHeight: 480,
      components: [
        {
          id: "menu",
          type: "MENU",
          content: { heading: "Menu", body: "", menuItemIds: [], displayMode: "HORIZONTAL" },
        },
        {
          id: "catalog",
          type: "CATALOG",
          content: { heading: "Products", body: "", catalogItemRefs: [] },
        },
      ],
    };
    const parsed = parse(landingPageSectionSchema, section);
    expect(parsed.maxHeight).toBe(480);
    expect(parsed.components.map((component) => component.content)).toMatchObject([
      { displayMode: "HORIZONTAL" },
      { displayMode: "HORIZONTAL" },
    ]);
    expect(parse(landingPageSectionSchema, { ...section, maxHeight: undefined }).maxHeight).toBe(0);
    for (const maxHeight of [-1, 3001, 1.5, Infinity, "480"]) {
      expect(() => parse(landingPageSectionSchema, { ...section, maxHeight })).toThrow();
    }
    expect(() =>
      parse(landingPageSectionSchema, {
        ...section,
        components: [
          {
            ...section.components[0],
            content: { ...section.components[0]?.content, displayMode: "DIAGONAL" },
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts a responsive component variant and safe action links", () => {
    const result = parse(landingPageVariantUpdateSchema, variant());
    expect(result.sections[0]?.components[0]?.type).toBe("HERO");
    expect(result.commerce.cartButtonLabel).toBe("Cart");
    expect(result.commerce.fulfillmentMethods).toEqual(["PICKUP", "DELIVERY"]);
  });

  it("accepts storefront settings and rejects unusable checkout combinations", () => {
    const configured = variant() as ReturnType<typeof variant> & {
      commerce: Record<string, unknown>;
    };
    configured.commerce = {
      orderingEnabled: true,
      cartButtonLabel: "My basket",
      cartButtonPosition: "BOTTOM_LEFT",
      fulfillmentMethods: ["DELIVERY"],
      paymentMethods: ["CASH_ON_DELIVERY"],
      checkoutInstructions: "Delivery is available from 9 AM to 5 PM.",
      minimumOrder: 250,
      deliveryFee: 50,
    };
    const parsed = parse(landingPageVariantUpdateSchema, configured);
    expect(parsed.commerce.minimumOrder).toBe(250);
    expect(parsed.commerce.deliveryFee).toBe(50);

    const withoutFulfillment = structuredClone(configured);
    withoutFulfillment.commerce.fulfillmentMethods = [];
    withoutFulfillment.commerce.paymentMethods = [];
    expect(() => parse(landingPageVariantUpdateSchema, withoutFulfillment)).toThrow();

    const mismatchedPayment = structuredClone(configured);
    mismatchedPayment.commerce.fulfillmentMethods = ["PICKUP"];
    expect(() => parse(landingPageVariantUpdateSchema, mismatchedPayment)).toThrow();

    const negativeFee = structuredClone(configured);
    negativeFee.commerce.deliveryFee = -1;
    expect(() => parse(landingPageVariantUpdateSchema, negativeFee)).toThrow();
  });

  it("rejects unsafe links and invalid theme colors", () => {
    const unsafe = variant();
    const hero = unsafe.sections[0]?.components[0];
    if (!hero) throw new Error("Expected a hero fixture");
    hero.content.primaryUrl = "javascript:alert(1)";
    expect(() => parse(landingPageVariantUpdateSchema, unsafe)).toThrow();

    const invalidTheme = variant();
    invalidTheme.theme.primaryColor = "pink";
    expect(() => parse(landingPageVariantUpdateSchema, invalidTheme)).toThrow();
  });

  it("requires unique section and component ids", () => {
    const duplicatedSection = variant();
    const section = duplicatedSection.sections[0];
    if (!section) throw new Error("Expected a section fixture");
    duplicatedSection.sections.push(structuredClone(section));
    expect(() => parse(landingPageVariantUpdateSchema, duplicatedSection)).toThrow();

    const duplicatedComponent = variant();
    const firstSection = duplicatedComponent.sections[0];
    const component = firstSection?.components[0];
    if (!firstSection || !component) throw new Error("Expected a component fixture");
    firstSection.components.push(structuredClone(component));
    expect(() => parse(landingPageVariantUpdateSchema, duplicatedComponent)).toThrow();
  });

  it("allows empty sections but requires at least one component across the page", () => {
    const withEmptySection = variant();
    const templateSection = withEmptySection.sections[0];
    if (!templateSection) throw new Error("Expected a section fixture");
    withEmptySection.sections.push({
      ...structuredClone(templateSection),
      id: "empty-section",
      name: "Empty",
      components: [],
    });
    expect(parse(landingPageVariantUpdateSchema, withEmptySection).sections).toHaveLength(2);

    const emptyPage = variant();
    const onlySection = emptyPage.sections[0];
    if (!onlySection) throw new Error("Expected a section fixture");
    onlySection.components = [];
    expect(() => parse(landingPageVariantUpdateSchema, emptyPage)).toThrow();
  });

  it("accepts a mixed food and merchandise catalog component", () => {
    const catalog = variant();
    const section = catalog.sections[0];
    if (!section) throw new Error("Expected a section fixture");
    section.components.push({
      id: "catalog-1",
      type: "CATALOG",
      enabled: true,
      width: "FULL",
      content: {
        heading: "Featured products",
        body: "Food, clothing, and farm products",
        catalogItemRefs: [
          { sourceType: "MENU_ITEM", sourceId: "507f1f77bcf86cd799439011" },
          { sourceType: "PRODUCT", sourceId: "507f191e810c19729de860ea" },
        ],
        columns: 3,
      },
    } as never);
    expect(parse(landingPageVariantUpdateSchema, catalog).sections[0]?.components).toHaveLength(2);
  });

  it("normalizes public slugs and rejects path-like values", () => {
    expect(
      parse(landingPageSettingsSchema, {
        slug: "Miss-V-Store",
        siteTitle: "Miss V Store",
        seoDescription: "Local food and farm products",
      }).slug,
    ).toBe("miss-v-store");
    expect(() =>
      parse(landingPageSettingsSchema, {
        slug: "../private",
        siteTitle: "Miss V Store",
        seoDescription: "",
      }),
    ).toThrow();
    expect(() =>
      parse(landingPageSettingsSchema, {
        slug: "api",
        siteTitle: "Miss V Store",
        seoDescription: "",
      }),
    ).toThrow();
  });
});

it("preserves component button colors and defaults catalog rows to horizontal", () => {
  const component = {
    id: "catalog",
    type: "CATALOG",
    buttonTextColor: "#123456",
    content: { heading: "Products", body: "", catalogItemRefs: [] },
  };
  const parsed = parse(landingPageComponentSchema, component);
  expect(parsed.buttonTextColor).toBe("#123456");
  if (parsed.type === "CATALOG") expect(parsed.content.displayMode).toBe("HORIZONTAL");
  expect(() =>
    parse(landingPageComponentSchema, { ...component, buttonTextColor: "invalid" }),
  ).toThrow();
});
