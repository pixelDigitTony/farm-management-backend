import * as v from "valibot";

const shortText = (maximum: number) => v.pipe(v.string(), v.trim(), v.maxLength(maximum));
const requiredText = (maximum: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maximum));
const safeLink = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(1000),
  v.check(
    (value) => /^(?:https:\/\/|mailto:|tel:|#|\/)/i.test(value),
    "Use an HTTPS, email, phone, anchor, or internal link",
  ),
);
const optionalUrl = v.optional(v.union([v.literal(""), safeLink]), "");
const mediaUrl = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(1000),
  v.check((value) => /^https:\/\//i.test(value), "Use a public HTTPS media link"),
);
const optionalMediaUrl = v.optional(v.union([v.literal(""), mediaUrl]), "");
const componentId = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(80),
  v.regex(/^[A-Za-z0-9_-]+$/),
);
const width = v.optional(v.picklist(["FULL", "TWO_THIRDS", "HALF", "THIRD"]), "FULL");
const enabled = v.optional(v.boolean(), true);
const color = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/));
const inheritedColor = v.optional(v.union([v.literal(""), color]), "");

const heroComponent = v.object({
  id: componentId,
  type: v.literal("HERO"),
  enabled,
  width,
  content: v.object({
    eyebrow: shortText(80),
    title: requiredText(120),
    body: shortText(500),
    mediaUrl: optionalMediaUrl,
    primaryLabel: shortText(40),
    primaryUrl: optionalUrl,
    secondaryLabel: shortText(40),
    secondaryUrl: optionalUrl,
  }),
});

const textComponent = v.object({
  id: componentId,
  type: v.literal("TEXT"),
  enabled,
  width,
  content: v.object({
    heading: requiredText(120),
    body: shortText(2000),
    alignment: v.optional(v.picklist(["LEFT", "CENTER"]), "LEFT"),
  }),
});

const menuComponent = v.object({
  id: componentId,
  type: v.literal("MENU"),
  enabled,
  width,
  content: v.object({
    heading: requiredText(120),
    body: shortText(500),
    menuItemIds: v.pipe(v.array(v.string()), v.maxLength(12)),
    columns: v.optional(v.picklist([2, 3, 4]), 3),
  }),
});

const galleryComponent = v.object({
  id: componentId,
  type: v.literal("GALLERY"),
  enabled,
  width,
  content: v.object({
    heading: requiredText(120),
    mediaUrls: v.pipe(
      v.array(mediaUrl),
      v.maxLength(12),
      v.check((items) => new Set(items).size === items.length, "Use each media link once"),
    ),
    columns: v.optional(v.picklist([2, 3, 4]), 3),
  }),
});

const contactComponent = v.object({
  id: componentId,
  type: v.literal("CONTACT"),
  enabled,
  width,
  content: v.object({
    heading: requiredText(120),
    body: shortText(500),
    address: shortText(300),
    phone: shortText(40),
    email: shortText(160),
    hours: shortText(300),
    facebookUrl: optionalUrl,
    instagramUrl: optionalUrl,
    mapUrl: optionalUrl,
  }),
});

const ctaComponent = v.object({
  id: componentId,
  type: v.literal("CTA"),
  enabled,
  width,
  content: v.object({
    heading: requiredText(120),
    body: shortText(500),
    buttonLabel: requiredText(40),
    buttonUrl: optionalUrl,
  }),
});

export const landingPageComponentSchema = v.variant("type", [
  heroComponent,
  textComponent,
  menuComponent,
  galleryComponent,
  contactComponent,
  ctaComponent,
]);

export const landingPageSectionSchema = v.object({
  id: componentId,
  name: requiredText(80),
  enabled,
  backgroundColor: inheritedColor,
  textColor: inheritedColor,
  contentWidth: v.optional(v.picklist(["FULL", "WIDE", "CONTAINED"]), "WIDE"),
  padding: v.optional(v.picklist(["NONE", "SMALL", "MEDIUM", "LARGE"]), "MEDIUM"),
  gap: v.optional(v.picklist(["NONE", "SMALL", "MEDIUM", "LARGE"]), "MEDIUM"),
  components: v.pipe(v.array(landingPageComponentSchema), v.maxLength(30)),
});

export const landingPageThemeSchema = v.object({
  primaryColor: color,
  backgroundColor: color,
  surfaceColor: color,
  textColor: color,
  fontStyle: v.picklist(["MODERN", "CLASSIC"]),
  buttonStyle: v.picklist(["ROUNDED", "PILL", "SQUARE"]),
});

export const landingPageSettingsSchema = v.object({
  slug: v.pipe(
    v.string(),
    v.trim(),
    v.toLowerCase(),
    v.minLength(3),
    v.maxLength(60),
    v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens"),
    v.check((slug) => !["api", "app", "www"].includes(slug), "That subdomain is reserved"),
  ),
  siteTitle: requiredText(120),
  seoDescription: shortText(240),
});

export const landingPageVariantCreateSchema = v.object({
  name: requiredText(80),
  duplicateFromId: v.optional(v.string()),
});

export const landingPageVariantUpdateSchema = v.object({
  name: requiredText(80),
  theme: landingPageThemeSchema,
  sections: v.pipe(
    v.array(landingPageSectionSchema),
    v.minLength(1),
    v.maxLength(20),
    v.check(
      (sections) => sections.reduce((count, section) => count + section.components.length, 0) >= 1,
      "Add at least one component before saving",
    ),
    v.check(
      (sections) => sections.reduce((count, section) => count + section.components.length, 0) <= 30,
      "Use no more than 30 components",
    ),
    v.check(
      (sections) => new Set(sections.map((section) => section.id)).size === sections.length,
      "Use a unique id for every section",
    ),
    v.check((sections) => {
      const ids = sections.flatMap((section) =>
        section.components.map((component) => component.id),
      );
      return new Set(ids).size === ids.length;
    }, "Use a unique id for every component"),
  ),
});

export type LandingPageVariantInput = v.InferOutput<typeof landingPageVariantUpdateSchema>;
