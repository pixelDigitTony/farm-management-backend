import { parse } from "valibot";
import { describe, expect, it } from "vitest";
import { createLandingPreset, landingTemplates } from "../src/services/landing-presets.js";
import {
  landingPageVariantCreateSchema,
  landingPageVariantUpdateSchema,
} from "../src/validation/landing-page.js";

const catalog = [
  {
    sourceType: "PRODUCT" as const,
    sourceId: "507f1f77bcf86cd799439011",
    name: "Merchant product",
    isAvailable: true,
    isFeatured: true,
    mediaUrls: ["https://example.test/product.webp"],
  },
];
describe("Universal V2 landing documents", () => {
  it("builds every recorded revision and never invents catalog data or testimonials", () => {
    for (const t of landingTemplates)
      for (let revision = 1; revision <= t.revision; revision++) {
        const doc = createLandingPreset(
          t.id,
          revision,
          undefined,
          { businessName: "Merchant" },
          catalog,
        );
        expect(doc.schemaVersion).toBe(2);
        expect(doc.template).toEqual({ id: t.id, revision });
        expect(doc.sections.length).toBeLessThanOrEqual(20);
        expect(doc.sections.flatMap((s) => s.components).length).toBeLessThanOrEqual(30);
        expect(
          doc.sections
            .flatMap((s) => s.components)
            .filter((c) => c.type === "TESTIMONIALS")
            .every((c) => c.content.entries.length === 0),
        ).toBe(true);
        expect(
          doc.sections
            .flatMap((s) => s.components)
            .filter((c) => c.type === "CATALOG")
            .every((c) =>
              c.content.catalogItemRefs.every((r) => r.sourceId === catalog[0]!.sourceId),
            ),
        ).toBe(true);
        expect(doc.theme.background?.mode).toBe(revision === t.revision ? "THREE_D" : undefined);
        expect(parse(landingPageVariantUpdateSchema, JSON.parse(JSON.stringify(doc)))).toEqual(doc);
      }
  });
  it("supports other industries and coherent independent conversion goals", () => {
    for (const t of landingTemplates)
      for (const goal of ["SHOP", "CATALOG", "INQUIRY"] as const) {
        const doc = createLandingPreset(
          t.id,
          undefined,
          goal,
          { businessName: "Universal apparel" },
          catalog,
        );
        expect(doc.goal).toBe(goal);
        expect(doc.commerce.orderingEnabled).toBe(goal === "SHOP");
        expect(doc.sections[0]?.components[0]?.type).toBe("HEADER");
        expect(doc.sections.at(-1)?.components.at(-1)?.type).toBe("FOOTER");
      }
    expect(createLandingPreset("bold-market", undefined, undefined, null, []).goal).toBe("CATALOG");
    const invalid = createLandingPreset("bold-market", undefined, "CATALOG", null, catalog);
    invalid.commerce.orderingEnabled = true;
    expect(() => parse(landingPageVariantUpdateSchema, invalid)).toThrow();
  });
  it("retains inactive background preferences and product bindings on mode changes", () => {
    const doc = createLandingPreset("everyday-boutique", undefined, "SHOP", null, catalog);
    const before = structuredClone(doc.sections);
    doc.theme.background!.image = {
      url: "/api/images/507f1f77bcf86cd799439011",
      alt: "Merchant backdrop",
      focalPoint: { x: 0.2, y: 0.7 },
      aspectRatio: "WIDE",
    };
    for (const mode of ["IMAGE", "COLOR", "THREE_D"] as const) {
      doc.theme.background!.mode = mode;
      const saved = parse(landingPageVariantUpdateSchema, doc);
      expect(saved.theme.background?.image).toEqual(doc.theme.background!.image);
      expect(saved.theme.background?.threeD).toEqual(doc.theme.background!.threeD);
      expect(saved.sections).toEqual(before);
    }
  });
  it("rejects unsupported revisions, media, effects, unsafe links and duplicate infrastructure", () => {
    expect(() => createLandingPreset("bold-market", 3, undefined, null, catalog)).toThrow();
    expect(() =>
      parse(landingPageVariantCreateSchema, {
        name: "Test",
        duplicateFromId: "x",
        templateId: "bold-market",
      }),
    ).toThrow();
    const doc = createLandingPreset("farm-and-market", undefined, "SHOP", null, catalog);
    for (const value of [NaN, Infinity, -0.1, 1]) {
      const copy = structuredClone(doc);
      copy.theme.background!.threeD!.overlayOpacity = value;
      expect(() => parse(landingPageVariantUpdateSchema, copy)).toThrow();
    }
    const header = doc.sections[0]!.components[0]!;
    if (header.type !== "HEADER") throw new Error("Fixture");
    for (const url of [
      "javascript:alert(1)",
      "//external.test",
      "/\\external.test",
      "data:text/html,x",
    ]) {
      const copy = structuredClone(doc);
      const c = copy.sections[0]!.components[0]!;
      if (c.type === "HEADER") c.content.messagingUrl = url;
      expect(() => parse(landingPageVariantUpdateSchema, copy)).toThrow();
    }
    const duplicate = structuredClone(doc);
    duplicate.sections[1]!.components.push({ ...header, id: "duplicate-header" });
    expect(() => parse(landingPageVariantUpdateSchema, duplicate)).toThrow();
    const broken = structuredClone(doc);
    const hero = broken.sections[1]!.components[0]!;
    if (hero.type === "HERO") hero.content.primaryUrl = "#missing";
    expect(() => parse(landingPageVariantUpdateSchema, broken)).toThrow();
    const oldClient = structuredClone(doc);
    delete oldClient.schemaVersion;
    expect(() => parse(landingPageVariantUpdateSchema, oldClient)).toThrow();
  });
});
