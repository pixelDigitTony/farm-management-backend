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
    components: [
      {
        id: "hero-1",
        type: "HERO",
        enabled: true,
        width: "FULL",
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
  };
}

describe("landing-page validation", () => {
  it("accepts a responsive component variant and safe action links", () => {
    const result = parse(landingPageVariantUpdateSchema, variant());
    expect(result.components[0]?.type).toBe("HERO");
  });

  it("rejects unsafe links and invalid theme colors", () => {
    const unsafe = variant();
    const hero = unsafe.components[0];
    if (!hero) throw new Error("Expected a hero fixture");
    hero.content.primaryUrl = "javascript:alert(1)";
    expect(() => parse(landingPageVariantUpdateSchema, unsafe)).toThrow();

    const invalidTheme = variant();
    invalidTheme.theme.primaryColor = "pink";
    expect(() => parse(landingPageVariantUpdateSchema, invalidTheme)).toThrow();
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
