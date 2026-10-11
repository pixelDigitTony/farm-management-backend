import * as v from "valibot";

const shortText = (maximum: number) => v.pipe(v.string(), v.trim(), v.maxLength(maximum));
const requiredText = (maximum: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maximum));
const safeLink = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(1000),
  v.check(
    (value) =>
      !value.includes("\\") &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
      /^(?:https:\/\/[^\s]+|mailto:[^\s]+|tel:[+\d() .-]+|#[A-Za-z0-9_-]+|\/(?!\/)[^\s]*)$/i.test(
        value,
      ),
    "Use an HTTPS, email, phone, anchor, or internal link",
  ),
);
const optionalUrl = v.optional(v.union([v.literal(""), safeLink]), "");
const mediaUrl = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(1000),
  v.check(
    (value) =>
      /^(?:https:\/\/[^\s]+|\/api\/images\/[a-f0-9]{24}|\/landing-assets\/(?:web|icons)\/[A-Za-z0-9_./-]+)$/i.test(
        value,
      ) && !value.includes(".."),
    "Use a public HTTPS media link",
  ),
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
const displayMode = v.optional(v.picklist(["VERTICAL", "HORIZONTAL"]), "HORIZONTAL");

export const templateIds = [
  "bold-market",
  "editorial-studio",
  "architectural-escape",
  "everyday-boutique",
  "farm-and-market",
] as const;
export const sceneIds = [
  "market-background",
  "studio-background",
  "haven-scenery",
  "boutique-background",
  "farm-scenery",
] as const;
export const motionSchema = v.object({
  preset: v.picklist(["NONE", "REVEAL", "PARALLAX", "IMAGE_REVEAL", "STICKY_STORY"]),
  intensity: v.picklist(["SUBTLE", "STANDARD"]),
  durationMs: v.pipe(v.number(), v.finite(), v.minValue(150), v.maxValue(900)),
  mobile: v.picklist(["STATIC", "SUBTLE"]),
});
const fraction = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));
export const mediaAssetSchema = v.object({
  url: mediaUrl,
  mobileUrl: v.optional(mediaUrl),
  alt: shortText(300),
  focalPoint: v.object({ x: fraction, y: fraction }),
  aspectRatio: v.picklist(["AUTO", "SQUARE", "PORTRAIT", "LANDSCAPE", "WIDE"]),
});
export const backgroundSchema = v.pipe(
  v.object({
    mode: v.picklist(["THREE_D", "IMAGE", "COLOR"]),
    color,
    image: v.optional(mediaAssetSchema),
    threeD: v.optional(
      v.object({
        sceneId: v.picklist(sceneIds),
        sceneRevision: v.literal(1),
        cameraPreset: v.picklist(["DESKTOP", "MOBILE"]),
        motion: v.picklist(["OFF", "SUBTLE"]),
        overlayOpacity: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(0.75)),
      }),
    ),
  }),
  v.check(
    (settings) => settings.mode !== "THREE_D" || Boolean(settings.threeD),
    "Choose a 3D scene",
  ),
  v.check(
    (settings) => settings.mode !== "IMAGE" || Boolean(settings.image),
    "Choose a background image",
  ),
);
export const actionTargetSchema = v.variant("kind", [
  v.object({ kind: v.literal("SECTION"), sectionId: componentId }),
  v.object({ kind: v.literal("LINK"), url: safeLink }),
]);
const action = v.object({ label: requiredText(40), target: actionTargetSchema });
export const blockLayouts = {
  HEADER: ["CENTERED", "SPLIT"],
  HERO: ["LEGACY", "POSTER", "COLLAGE", "ARCHITECTURAL", "PHOTO_STRIP", "LANDSCAPE_BANNER"],
  TEXT: ["CENTERED", "SPLIT"],
  CATALOG: ["GRID", "RAIL"],
  MENU: ["GRID", "RAIL"],
  GALLERY: ["GRID", "RAIL", "COLLAGE"],
  CONTACT: ["SPLIT", "CENTERED"],
  CTA: ["CENTERED", "SPLIT"],
  FOOTER: ["CENTERED", "SPLIT"],
  FEATURES: ["GRID", "RAIL"],
  SHOWCASE: ["GRID", "OFFERING_PATHS"],
  MEDIA_STORY: ["STORY", "LOOKBOOK", "PORTAL"],
  TESTIMONIALS: ["GRID", "RAIL"],
  FAQ: ["GRID"],
} as const;
const appearance = v.optional(
  v.object({
    layout: v.optional(
      v.picklist([
        "LEGACY",
        "POSTER",
        "COLLAGE",
        "ARCHITECTURAL",
        "PHOTO_STRIP",
        "LANDSCAPE_BANNER",
        "GRID",
        "RAIL",
        "OFFERING_PATHS",
        "PORTAL",
        "LOOKBOOK",
        "STORY",
        "CENTERED",
        "SPLIT",
      ]),
    ),
    cardLayout: v.optional(v.picklist(["STANDARD", "COMPACT", "BOUTIQUE"])),
    panelPlacement: v.optional(v.picklist(["OVERLAP", "BELOW"])),
    showNumbers: v.optional(v.boolean()),
    showRating: v.optional(v.boolean()),
    showSoldCount: v.optional(v.boolean()),
    showQuickView: v.optional(v.boolean()),
    showShopNow: v.optional(v.boolean()),
    showAddToCart: v.optional(v.boolean()),
    addLabel: v.optional(requiredText(40)),
    shopLabel: v.optional(requiredText(40)),
    quickLabel: v.optional(requiredText(40)),
    orderPresentation: v.optional(v.picklist(["DEFAULT", "INLINE_SUMMARY"])),
    alignment: v.optional(v.picklist(["LEFT", "CENTER", "RIGHT"])),
    mediaRatio: v.optional(v.picklist(["AUTO", "SQUARE", "PORTRAIT", "LANDSCAPE", "WIDE"])),
    mobile: v.optional(
      v.object({
        padding: v.optional(v.picklist(["NONE", "SMALL", "MEDIUM", "LARGE"])),
        columns: v.optional(v.picklist([1, 2])),
        panelPlacement: v.optional(v.picklist(["BELOW"])),
      }),
    ),
  }),
);
const v2Base = { appearance, motion: v.optional(motionSchema) };

const heroComponent = v.object({
  ...v2Base,
  id: componentId,
  type: v.literal("HERO"),
  enabled,
  width,
  buttonTextColor: v.optional(v.union([v.literal(""), color])),
  content: v.object({
    eyebrow: shortText(80),
    title: requiredText(120),
    body: shortText(500),
    mediaUrl: optionalMediaUrl,
    primaryLabel: shortText(40),
    primaryUrl: optionalUrl,
    secondaryLabel: shortText(40),
    secondaryUrl: optionalUrl,
    media: v.optional(mediaAssetSchema),
    stripMedia: v.optional(v.pipe(v.array(mediaAssetSchema), v.maxLength(4))),
    layers: v.optional(
      v.pipe(
        v.array(
          v.object({
            id: componentId,
            media: mediaAssetSchema,
            depth: v.picklist(["BACKGROUND", "SUBJECT", "FOREGROUND"]),
          }),
        ),
        v.maxLength(5),
      ),
    ),
    missionText: v.optional(shortText(300)),
  }),
});

const textComponent = v.object({
  ...v2Base,
  id: componentId,
  type: v.literal("TEXT"),
  enabled,
  width,
  buttonTextColor: v.optional(v.union([v.literal(""), color])),
  content: v.object({
    heading: requiredText(120),
    body: shortText(2000),
    alignment: v.optional(v.picklist(["LEFT", "CENTER"]), "LEFT"),
  }),
});

const menuComponent = v.object({
  ...v2Base,
  id: componentId,
  type: v.literal("MENU"),
  enabled,
  width,
  buttonTextColor: v.optional(v.union([v.literal(""), color])),
  content: v.object({
    heading: requiredText(120),
    body: shortText(500),
    menuItemIds: v.pipe(v.array(v.string()), v.maxLength(12)),
    displayMode,
    columns: v.optional(v.picklist([2, 3, 4]), 3),
  }),
});

const catalogReference = v.object({
  sourceType: v.picklist(["MENU_ITEM", "PRODUCT"]),
  sourceId: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
});

const catalogComponent = v.object({
  ...v2Base,
  id: componentId,
  type: v.literal("CATALOG"),
  enabled,
  width,
  buttonTextColor: v.optional(v.union([v.literal(""), color])),
  content: v.object({
    heading: requiredText(120),
    body: shortText(500),
    catalogItemRefs: v.pipe(
      v.array(catalogReference),
      v.maxLength(24),
      v.check(
        (items) =>
          new Set(items.map((item) => `${item.sourceType}:${item.sourceId}`)).size === items.length,
        "Select each catalog item once",
      ),
    ),
    displayMode: v.optional(v.picklist(["VERTICAL", "HORIZONTAL"]), "HORIZONTAL"),
    columns: v.optional(v.picklist([2, 3, 4]), 3),
  }),
});

const galleryComponent = v.object({
  ...v2Base,
  id: componentId,
  type: v.literal("GALLERY"),
  enabled,
  width,
  buttonTextColor: v.optional(v.union([v.literal(""), color])),
  content: v.object({
    heading: requiredText(120),
    mediaUrls: v.pipe(
      v.array(mediaUrl),
      v.maxLength(12),
      v.check((items) => new Set(items).size === items.length, "Use each media link once"),
    ),
    columns: v.optional(v.picklist([2, 3, 4]), 3),
    media: v.optional(v.pipe(v.array(mediaAssetSchema), v.maxLength(12))),
  }),
});

const contactComponent = v.object({
  ...v2Base,
  id: componentId,
  type: v.literal("CONTACT"),
  enabled,
  width,
  buttonTextColor: v.optional(v.union([v.literal(""), color])),
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
  ...v2Base,
  id: componentId,
  type: v.literal("CTA"),
  enabled,
  width,
  buttonTextColor: v.optional(v.union([v.literal(""), color])),
  content: v.object({
    heading: requiredText(120),
    body: shortText(500),
    buttonLabel: requiredText(40),
    buttonUrl: optionalUrl,
  }),
});

const base = {
  id: componentId,
  enabled,
  width,
  buttonTextColor: v.optional(v.union([v.literal(""), color])),
  ...v2Base,
};
const navLinks = v.pipe(v.array(action), v.maxLength(8));
const headerComponent = v.object({
  ...base,
  type: v.literal("HEADER"),
  content: v.object({
    brand: requiredText(120),
    tagline: shortText(120),
    logo: v.optional(mediaAssetSchema),
    navigation: navLinks,
    action: v.optional(action),
    messagingUrl: optionalUrl,
    showSearch: v.boolean(),
    showCart: v.boolean(),
  }),
});
const footerComponent = v.object({
  ...base,
  type: v.literal("FOOTER"),
  content: v.object({
    brand: requiredText(120),
    statement: shortText(300),
    legal: shortText(300),
    links: navLinks,
  }),
});
const featuresComponent = v.object({
  ...base,
  type: v.literal("FEATURES"),
  content: v.object({
    heading: shortText(120),
    items: v.pipe(
      v.array(
        v.object({
          id: componentId,
          icon: v.picklist([
            "leaf",
            "shield",
            "truck",
            "wallet",
            "pin",
            "shirt",
            "package",
            "heart",
            "home",
            "star",
          ]),
          title: requiredText(120),
          body: shortText(500),
          action: v.optional(action),
        }),
      ),
      v.maxLength(8),
    ),
  }),
});
const showcaseComponent = v.object({
  ...base,
  type: v.literal("SHOWCASE"),
  content: v.object({
    heading: requiredText(120),
    body: shortText(500),
    items: v.pipe(
      v.array(
        v.object({
          id: componentId,
          title: requiredText(120),
          body: shortText(500),
          media: v.optional(mediaAssetSchema),
          attributes: v.pipe(
            v.array(v.object({ label: requiredText(80), value: shortText(160) })),
            v.maxLength(6),
          ),
          actions: v.pipe(v.array(action), v.maxLength(2)),
        }),
      ),
      v.maxLength(12),
    ),
  }),
});
const storyComponent = v.object({
  ...base,
  type: v.literal("MEDIA_STORY"),
  content: v.object({
    heading: requiredText(120),
    body: shortText(2000),
    frames: v.pipe(
      v.array(
        v.object({
          id: componentId,
          media: mediaAssetSchema,
          caption: shortText(300),
          catalogRef: v.optional(catalogReference),
        }),
      ),
      v.maxLength(4),
    ),
    action: v.optional(action),
  }),
});
const testimonialsComponent = v.object({
  ...base,
  type: v.literal("TESTIMONIALS"),
  content: v.object({
    heading: requiredText(120),
    displayMode: v.picklist(["RAIL", "GRID"]),
    entries: v.pipe(
      v.array(
        v.object({
          id: componentId,
          quote: requiredText(600),
          author: requiredText(100),
          thumbnail: v.optional(mediaAssetSchema),
          rating: v.optional(v.pipe(v.number(), v.finite(), v.minValue(1), v.maxValue(5))),
          catalogRef: v.optional(catalogReference),
          enabled,
        }),
      ),
      v.maxLength(12),
    ),
  }),
});
const faqComponent = v.object({
  ...base,
  type: v.literal("FAQ"),
  content: v.object({
    heading: requiredText(120),
    items: v.pipe(
      v.array(
        v.object({ id: componentId, question: requiredText(200), answer: requiredText(1000) }),
      ),
      v.maxLength(10),
    ),
  }),
});

export const landingPageComponentSchema = v.variant("type", [
  heroComponent,
  textComponent,
  menuComponent,
  catalogComponent,
  galleryComponent,
  contactComponent,
  ctaComponent,
  headerComponent,
  footerComponent,
  featuresComponent,
  showcaseComponent,
  storyComponent,
  testimonialsComponent,
  faqComponent,
]);

export const landingPageSectionSchema = v.object({
  anchor: v.optional(componentId),
  layoutVariant: v.optional(v.picklist(["DEFAULT", "HERO", "FULL_BLEED", "COMPACT", "STORY"])),
  motion: v.optional(motionSchema),
  background: v.optional(backgroundSchema),
  mobile: v.optional(
    v.object({
      padding: v.picklist(["NONE", "SMALL", "MEDIUM", "LARGE"]),
      gap: v.picklist(["NONE", "SMALL", "MEDIUM", "LARGE"]),
    }),
  ),
  id: componentId,
  name: requiredText(80),
  enabled,
  backgroundColor: inheritedColor,
  textColor: inheritedColor,
  contentWidth: v.optional(v.picklist(["FULL", "WIDE", "CONTAINED"]), "WIDE"),
  padding: v.optional(v.picklist(["NONE", "SMALL", "MEDIUM", "LARGE"]), "MEDIUM"),
  gap: v.optional(v.picklist(["NONE", "SMALL", "MEDIUM", "LARGE"]), "MEDIUM"),
  maxHeight: v.optional(
    v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0), v.maxValue(3000)),
    0,
  ),
  components: v.pipe(v.array(landingPageComponentSchema), v.maxLength(30)),
});

export const landingPageThemeSchema = v.object({
  accentColor: v.optional(color),
  mutedTextColor: v.optional(color),
  borderColor: v.optional(color),
  displayFont: v.optional(
    v.picklist(["LEGACY", "DISPLAY_CONDENSED", "EDITORIAL_SERIF", "MODERN_GROTESK"]),
  ),
  bodyFont: v.optional(v.picklist(["SYSTEM", "APP_SANS"])),
  contentMaxWidth: v.optional(v.picklist([1120, 1280, 1440])),
  motionLevel: v.optional(v.picklist(["OFF", "SUBTLE", "EXPRESSIVE"])),
  background: v.optional(backgroundSchema),
  primaryColor: color,
  backgroundColor: color,
  surfaceColor: color,
  textColor: color,
  fontStyle: v.picklist(["MODERN", "CLASSIC"]),
  buttonStyle: v.picklist(["ROUNDED", "PILL", "SQUARE"]),
});

export const defaultLandingPageCommerceSettings = {
  orderingEnabled: true,
  cartButtonLabel: "Cart",
  cartButtonPosition: "BOTTOM_RIGHT" as const,
  fulfillmentMethods: ["PICKUP", "DELIVERY"] as Array<"PICKUP" | "DELIVERY">,
  paymentMethods: ["PAY_ON_PICKUP", "CASH_ON_DELIVERY"] as Array<
    "PAY_ON_PICKUP" | "CASH_ON_DELIVERY"
  >,
  checkoutInstructions: "The owner will review your order before confirming it.",
  minimumOrder: 0,
  deliveryFee: 0,
};

const uniqueSelection = <T>(items: T[]) => new Set(items).size === items.length;

export const landingPageCommerceSettingsSchema = v.pipe(
  v.object({
    contactBlockId: v.optional(componentId),
    orderingEnabled: v.optional(v.boolean(), true),
    cartButtonLabel: v.optional(requiredText(30), "Cart"),
    cartButtonPosition: v.optional(v.picklist(["BOTTOM_RIGHT", "BOTTOM_LEFT"]), "BOTTOM_RIGHT"),
    fulfillmentMethods: v.optional(
      v.pipe(
        v.array(v.picklist(["PICKUP", "DELIVERY"])),
        v.maxLength(2),
        v.check(uniqueSelection, "Select each fulfillment method once"),
      ),
      ["PICKUP", "DELIVERY"],
    ),
    paymentMethods: v.optional(
      v.pipe(
        v.array(v.picklist(["PAY_ON_PICKUP", "CASH_ON_DELIVERY"])),
        v.maxLength(2),
        v.check(uniqueSelection, "Select each payment method once"),
      ),
      ["PAY_ON_PICKUP", "CASH_ON_DELIVERY"],
    ),
    checkoutInstructions: v.optional(
      shortText(500),
      defaultLandingPageCommerceSettings.checkoutInstructions,
    ),
    minimumOrder: v.optional(
      v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1_000_000)),
      0,
    ),
    deliveryFee: v.optional(
      v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1_000_000)),
      0,
    ),
  }),
  v.check(
    (settings) => !settings.orderingEnabled || settings.fulfillmentMethods.length > 0,
    "Enable at least one fulfillment method when ordering is enabled",
  ),
  v.check(
    (settings) =>
      !settings.fulfillmentMethods.includes("PICKUP") ||
      settings.paymentMethods.includes("PAY_ON_PICKUP"),
    "Pickup requires pay on pickup",
  ),
  v.check(
    (settings) =>
      !settings.fulfillmentMethods.includes("DELIVERY") ||
      settings.paymentMethods.includes("CASH_ON_DELIVERY"),
    "Delivery requires cash on delivery",
  ),
  v.check(
    (settings) =>
      !settings.paymentMethods.includes("PAY_ON_PICKUP") ||
      settings.fulfillmentMethods.includes("PICKUP"),
    "Pay on pickup requires pickup fulfillment",
  ),
  v.check(
    (settings) =>
      !settings.paymentMethods.includes("CASH_ON_DELIVERY") ||
      settings.fulfillmentMethods.includes("DELIVERY"),
    "Cash on delivery requires delivery fulfillment",
  ),
);

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

export const landingPageVariantCreateSchema = v.pipe(
  v.object({
    name: requiredText(80),
    duplicateFromId: v.optional(v.string()),
    templateId: v.optional(v.picklist(templateIds)),
    templateRevision: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3))),
    goal: v.optional(v.picklist(["SHOP", "CATALOG", "INQUIRY"])),
  }),
  v.check(
    (input) => !(input.duplicateFromId && input.templateId),
    "Choose either duplication or a template",
  ),
);

export const landingPageVariantUpdateSchema = v.pipe(
  v.object({
    schemaVersion: v.optional(v.picklist([1, 2])),
    template: v.optional(
      v.object({
        id: v.picklist(templateIds),
        revision: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)),
      }),
    ),
    goal: v.optional(v.picklist(["SHOP", "CATALOG", "INQUIRY"])),
    name: requiredText(80),
    theme: landingPageThemeSchema,
    commerce: v.optional(landingPageCommerceSettingsSchema, defaultLandingPageCommerceSettings),
    sections: v.pipe(
      v.array(landingPageSectionSchema),
      v.minLength(1),
      v.maxLength(20),
      v.check(
        (sections) =>
          sections.reduce((count, section) => count + section.components.length, 0) >= 1,
        "Add at least one component before saving",
      ),
      v.check(
        (sections) =>
          sections.reduce((count, section) => count + section.components.length, 0) <= 30,
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
  }),
  v.check(
    (doc) =>
      doc.schemaVersion !== 2 ||
      Boolean(doc.template && doc.goal && doc.theme.displayFont && doc.theme.motionLevel),
    "V2 requires template, goal and theme metadata",
  ),
  v.check(
    (doc) =>
      doc.schemaVersion === 2 ||
      (!doc.template &&
        !doc.goal &&
        doc.sections.every((s) =>
          s.components.every((c) =>
            ["HERO", "TEXT", "MENU", "CATALOG", "GALLERY", "CONTACT", "CTA"].includes(c.type),
          ),
        )),
    "Upgrade to V2 before adding V2 blocks",
  ),
  v.check(
    (doc) => !doc.goal || doc.goal === "SHOP" || !doc.commerce.orderingEnabled,
    "Catalog and inquiry pages cannot enable ordering",
  ),
  v.check(
    (doc) =>
      !doc.template || doc.template.revision <= (doc.template.id === "everyday-boutique" ? 3 : 2),
    "Unsupported template revision",
  ),
  v.check(
    (doc) =>
      doc.schemaVersion !== 2 ||
      doc.sections.every((s) =>
        s.components.every(
          (c) =>
            !c.appearance?.layout ||
            (blockLayouts[c.type] as readonly string[]).includes(c.appearance.layout),
        ),
      ),
    "Choose a layout supported by this block",
  ),
  v.check(
    (doc) =>
      doc.schemaVersion !== 2 ||
      doc.sections.every((s) =>
        s.components.every(
          (c) => !c.appearance?.orderPresentation || c.type === "CATALOG" || c.type === "MENU",
        ),
      ),
    "Inline ordering belongs to a catalog or menu block",
  ),
  v.check((doc) => {
    if (doc.schemaVersion !== 2) return true;
    function uniqueEntries(value: unknown): boolean {
      if (!value || typeof value !== "object") return true;
      if (Array.isArray(value)) {
        const ids = value
          .filter((x) => x && typeof x === "object" && "id" in x)
          .map((x) => String(x.id));
        return new Set(ids).size === ids.length && value.every(uniqueEntries);
      }
      return Object.values(value).every(uniqueEntries);
    }
    return uniqueEntries(doc.sections);
  }, "Use a unique ID for each media layer and content entry"),
  v.check((doc) => {
    if (doc.schemaVersion !== 2) return true;
    const visible = doc.sections
      .filter((s) => s.enabled)
      .flatMap((s) => s.components.filter((c) => c.enabled));
    return (
      visible.filter((c) => c.type === "HEADER").length <= 1 &&
      visible.filter((c) => c.type === "FOOTER").length <= 1 &&
      (!visible.some((c) => c.type === "HEADER") || visible[0]?.type === "HEADER") &&
      (!visible.some((c) => c.type === "FOOTER") || visible.at(-1)?.type === "FOOTER") &&
      visible.filter((c) => c.appearance?.orderPresentation === "INLINE_SUMMARY").length <= 1 &&
      doc.sections.every((s) =>
        s.components.every(
          (c) =>
            c.type !== "SHOWCASE" ||
            c.appearance?.layout !== "OFFERING_PATHS" ||
            c.content.items.length <= 6,
        ),
      )
    );
  }, "Keep one header first, one footer last and one inline order section; offering paths allow six items"),
  v.check((doc) => {
    if (doc.schemaVersion !== 2 || !doc.commerce.contactBlockId) return true;
    return doc.sections.some(
      (s) =>
        s.enabled &&
        s.components.some(
          (c) => c.enabled && c.type === "CONTACT" && c.id === doc.commerce.contactBlockId,
        ),
    );
  }, "Choose an enabled contact block"),
  v.check((doc) => {
    if (doc.schemaVersion !== 2) return true;
    const ids = doc.sections
      .filter((s) => s.enabled)
      .flatMap((s) => [s.id, ...(s.anchor ? [s.anchor] : [])]);
    const targets: string[] = [];
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.kind === "SECTION") targets.push(String(record.sectionId));
      for (const [key, item] of Object.entries(record)) {
        if (
          (key.endsWith("Url") || key === "url") &&
          typeof item === "string" &&
          item.startsWith("#")
        )
          targets.push(item.slice(1));
        else if (item && typeof item === "object") visit(item);
      }
    }
    doc.sections
      .filter((s) => s.enabled)
      .forEach((s) => {
        s.components.filter((c) => c.enabled).forEach(visit);
      });
    const renderedIds = doc.sections.flatMap((s) => [
      s.id,
      ...(s.anchor && s.anchor !== s.id ? [s.anchor] : []),
    ]);
    return (
      new Set(renderedIds).size === renderedIds.length && targets.every((id) => ids.includes(id))
    );
  }, "An action points to a hidden, deleted or duplicate section anchor"),
);

export type LandingPageVariantInput = v.InferOutput<typeof landingPageVariantUpdateSchema>;
