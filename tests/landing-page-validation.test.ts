import { parse } from "valibot";
import { describe, expect, it } from "vitest";
import {
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
  it("accepts a responsive component variant and safe action links", () => {
    const result = parse(landingPageVariantUpdateSchema, variant());
    expect(result.sections[0]?.components[0]?.type).toBe("HERO");
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
