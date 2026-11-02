import { describe, expect, it } from "vitest";
import { defaultLandingSections } from "../src/services/landing-page-template.js";
import { createLandingPreset, landingTemplates } from "../src/services/landing-presets.js";

const catalog = [
  {
    sourceType: "PRODUCT" as const,
    sourceId: "507f1f77bcf86cd799439011",
    name: "First product",
    isAvailable: true,
    isFeatured: true,
    mediaUrls: ["https://example.test/first.webp"],
  },
  {
    sourceType: "PRODUCT" as const,
    sourceId: "507f1f77bcf86cd799439012",
    name: "Second product",
    isAvailable: true,
    isFeatured: false,
    mediaUrls: [],
  },
];

describe("mobile refinement preset defaults", () => {
  it("creates neutral, unlinked story frames across supported templates and revisions", () => {
    for (const template of landingTemplates) {
      for (let revision = 1; revision <= template.revision; revision++) {
        const doc = createLandingPreset(template.id, revision, undefined, null, catalog);
        const blocks = doc.sections.flatMap((section) => section.components);
        for (const block of blocks) {
          if (block.type === "MEDIA_STORY") {
            expect(block.content.body).toBe("Explore the details.");
            expect(block.content.frames.every((frame) => !frame.catalogRef)).toBe(true);
          }
        }
        expect(JSON.stringify(doc)).not.toMatch(/Add your story|Your brand/);
      }
    }
  });

  it("prioritizes contact for inquiry while preserving collection access", () => {
    const doc = createLandingPreset("architectural-escape", undefined, "INQUIRY", null, catalog);
    const hero = doc.sections
      .flatMap((section) => section.components)
      .find((b) => b.type === "HERO");
    if (!hero || hero.type !== "HERO") throw new Error("Missing hero");
    expect([hero.content.primaryLabel, hero.content.primaryUrl]).toEqual([
      "Get in touch",
      "#contact",
    ]);
    expect([hero.content.secondaryLabel, hero.content.secondaryUrl]).toEqual([
      "Explore offerings",
      "#collection",
    ]);
    expect(doc.commerce.orderingEnabled).toBe(false);
  });

  it.each(["SHOP", "CATALOG", "INQUIRY"] as const)(
    "gives Farm %s featured cards truthful destinations",
    (goal) => {
      const doc = createLandingPreset("farm-and-market", undefined, goal, null, catalog);
      const showcase = doc.sections
        .flatMap((section) => section.components)
        .find((b) => b.type === "SHOWCASE");
      if (!showcase || showcase.type !== "SHOWCASE") throw new Error("Missing showcase");
      expect(showcase.content.heading).toBe("Featured products");
      expect(showcase.content.body).toBe("Explore our collection.");
      expect(showcase.content.items.map((item) => item.title)).toEqual([
        "First product",
        "Second product",
      ]);
      for (const item of showcase.content.items) {
        expect(item.actions[0]).toMatchObject({
          label: goal === "INQUIRY" ? "Contact us" : "Browse collection",
          target: { kind: "SECTION", sectionId: goal === "INQUIRY" ? "contact" : "order" },
        });
      }
      expect(doc.commerce.orderingEnabled).toBe(goal === "SHOP");
    },
  );

  it("leaves merchant-authored snapshots untouched when generating another default", () => {
    const saved = createLandingPreset("editorial-studio", 1, "SHOP", null, catalog);
    const story = saved.sections
      .flatMap((section) => section.components)
      .find((b) => b.type === "MEDIA_STORY");
    if (!story || story.type !== "MEDIA_STORY") throw new Error("Missing story");
    story.content.body = "Merchant's own story";
    story.content.frames[0]!.catalogRef = { sourceType: "PRODUCT", sourceId: catalog[1]!.sourceId };
    const snapshot = structuredClone(saved);
    createLandingPreset("editorial-studio", undefined, "SHOP", null, catalog);
    expect(saved).toEqual(snapshot);
  });

  it("uses neutral generic creation copy without assuming fulfillment methods", () => {
    const text = JSON.stringify(defaultLandingSections(null, catalog));
    expect(text).not.toMatch(/pickup or delivery/i);
    expect(text).toContain("Explore our collection and contact us with any questions.");
  });
});
