import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { HttpError } from "../lib/http-error.js";
import {
  defaultLandingPageCommerceSettings,
  type LandingPageVariantInput,
  landingPageVariantUpdateSchema,
  type templateIds,
} from "../validation/landing-page.js";
import pack from "./landing-assets.json" with { type: "json" };
import { createSection } from "./landing-page-template.js";

type TemplateId = (typeof templateIds)[number];
type Goal = "SHOP" | "CATALOG" | "INQUIRY";
type Block = LandingPageVariantInput["sections"][number]["components"][number];
type Business = {
  businessName?: string;
  karenderiya?: { address?: string };
  piggery?: { address?: string };
} | null;
type CatalogItem = {
  sourceType: "MENU_ITEM" | "PRODUCT";
  sourceId: string;
  name: string;
  mediaUrls: string[];
  isAvailable: boolean;
  isFeatured: boolean;
};
const definitions = [
  {
    id: "bold-market",
    revision: 2,
    name: "Bold Market",
    description: "Warm color, a layered product hero and a story that leads into your collection.",
    category: "Food · Products",
    goal: "SHOP",
    sceneId: "market-background",
    preview: "market-hero",
    sections: [
      "Welcome",
      "Highlights",
      "Collection",
      "Our craft",
      "Serving story",
      "Questions",
      "Contact",
    ],
  },
  {
    id: "editorial-studio",
    revision: 2,
    name: "Editorial Studio",
    description: "An expressive collage, selectable lookbook and bold collection rail.",
    category: "Fashion · Accessories",
    goal: "SHOP",
    sceneId: "studio-background",
    preview: "studio-portrait",
    sections: ["Welcome", "Lookbook", "Collection", "Materials", "Contact"],
  },
  {
    id: "architectural-escape",
    revision: 2,
    name: "Architectural Escape",
    description: "An expansive landscape, inside-outside story and an inquiry-led showcase.",
    category: "Property · Services",
    goal: "INQUIRY",
    sceneId: "haven-scenery",
    preview: "haven-3d-exterior",
    sections: ["Welcome", "Details", "Inside and outside", "Offerings", "Gallery", "Contact"],
  },
  {
    id: "everyday-boutique",
    revision: 3,
    name: "Boutique Classic",
    description:
      "Four-photo strip, compact product cards, customer stories and a collection close.",
    category: "Boutique · Retail",
    goal: "SHOP",
    sceneId: "boutique-background",
    preview: "boutique-red",
    sections: [
      "Welcome",
      "Featured arrivals",
      "Highlights",
      "Customer stories",
      "Collection close",
      "Contact",
    ],
  },
  {
    id: "farm-and-market",
    revision: 2,
    name: "Farm & Market",
    description:
      "A landscape banner, three offering paths and a connected inline cart and order review.",
    category: "Community · Commerce",
    goal: "SHOP",
    sceneId: "farm-scenery",
    preview: "farm-3d-landscape",
    orderingPreview: "market-ribs",
    sections: ["Welcome", "Offerings", "Our promise", "Order", "Contact"],
  },
] as const;
export const landingTemplates = definitions.map((d) => ({
  ...d,
  preview: `/landing-assets/previews/${d.id}.webp`,
  mobilePreview: pack.scenes.find((s) => s.id === d.sceneId)!.mobilePoster,
  orderingPreview:
    "orderingPreview" in d ? "/landing-assets/previews/farm-and-market-ordering.webp" : undefined,
}));
export const landingScenes = pack.scenes;
const palettes: Record<TemplateId, string[]> = {
  "bold-market": ["#701E26", "#FFF4DF", "#FFFFFF", "#242019", "#DC4028"],
  "editorial-studio": ["#2447D8", "#F5F1EB", "#E8DFF0", "#171719", "#DDF16D"],
  "architectural-escape": ["#315638", "#F5F3EC", "#FFFFFF", "#202D26", "#D8C5A4"],
  "everyday-boutique": ["#EC8C7D", "#F7F1E1", "#FFFFFF", "#151713", "#F2D5CB"],
  "farm-and-market": ["#315638", "#F6F3E7", "#FFFFFF", "#252525", "#D6D6CD"],
};
function media(id: keyof typeof pack.assets) {
  const a = pack.assets[id];
  return { url: a.url, alt: a.alt, focalPoint: a.focalPoint, aspectRatio: "AUTO" as const };
}
export function createLandingPreset(
  id: TemplateId,
  revision: number | undefined,
  goal: Goal | undefined,
  business: Business,
  catalog: CatalogItem[],
): LandingPageVariantInput {
  const definition = definitions.find((d) => d.id === id);
  if (!definition) throw new HttpError(422, "Unknown landing template");
  const rev = revision ?? definition.revision;
  if (!Number.isInteger(rev) || rev < 1 || rev > definition.revision)
    throw new HttpError(422, "Unsupported template revision");
  const active = catalog
    .filter((i) => i.isAvailable)
    .sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured));
  const resolvedGoal =
    goal ?? (definition.goal === "SHOP" && !active.length ? "CATALOG" : definition.goal);
  const brand = business?.businessName?.slice(0, 120) || "Your brand";
  const [primaryColor, backgroundColor, surfaceColor, textColor, accentColor] = palettes[id] as [
    string,
    string,
    string,
    string,
    string,
  ];
  const background = {
    mode: "THREE_D" as const,
    color: backgroundColor,
    threeD: {
      sceneId: definition.sceneId,
      sceneRevision: 1 as const,
      cameraPreset: "DESKTOP" as const,
      motion: "SUBTLE" as const,
      overlayOpacity: id === "architectural-escape" || id === "farm-and-market" ? 0.3 : 0,
    },
  };
  const theme = {
    primaryColor,
    backgroundColor,
    surfaceColor,
    textColor,
    accentColor,
    mutedTextColor: "#5C5A54",
    borderColor: "#D6D6CD",
    fontStyle: "MODERN" as const,
    buttonStyle: id === "everyday-boutique" ? ("ROUNDED" as const) : ("PILL" as const),
    displayFont:
      id === "architectural-escape" || id === "farm-and-market"
        ? ("EDITORIAL_SERIF" as const)
        : id === "bold-market" || id === "everyday-boutique"
          ? ("DISPLAY_CONDENSED" as const)
          : ("MODERN_GROTESK" as const),
    bodyFont: "APP_SANS" as const,
    contentMaxWidth: 1280 as const,
    motionLevel: "SUBTLE" as const,
    ...(rev === definition.revision ? { background } : {}),
  };
  const sections: LandingPageVariantInput["sections"] = [];
  const block = (
    type: Block["type"],
    content: unknown,
    appearance?: Block["appearance"],
    motion?: Block["motion"],
  ) =>
    ({
      id: randomUUID(),
      type,
      enabled: true,
      width: "FULL",
      content,
      appearance,
      motion,
    }) as Block;
  const add = (
    name: string,
    anchor: string,
    components: Block[],
    options: Partial<LandingPageVariantInput["sections"][number]> = {},
  ) => {
    const s = createSection(name, components, { id: anchor, anchor, ...options });
    sections.push(s);
    return s;
  };
  const target = (sectionId: string) => ({ kind: "SECTION" as const, sectionId });
  const action = (label: string, sectionId: string) => ({ label, target: target(sectionId) });
  const reveal = {
    preset: "REVEAL" as const,
    intensity: "SUBTLE" as const,
    durationMs: 450,
    mobile: "STATIC" as const,
  };
  const contact = block("CONTACT", {
    heading: "Visit or contact us",
    body: "Tell us what you are looking for.",
    address: (business?.karenderiya?.address || business?.piggery?.address || "").slice(0, 300),
    phone: "",
    email: "",
    hours: "",
    facebookUrl: "",
    instagramUrl: "",
    mapUrl: "",
  });
  const collectionAnchor = id === "farm-and-market" ? "order" : "collection";
  const nav = [action("Explore", collectionAnchor), action("Contact", "contact")];
  add(
    "Header",
    "site-header",
    [
      block("HEADER", {
        brand,
        tagline: "",
        navigation: nav,
        messagingUrl: "",
        showSearch: resolvedGoal !== "INQUIRY",
        showCart: resolvedGoal === "SHOP",
      }),
    ],
    { padding: "SMALL", gap: "NONE" },
  );
  const layouts = {
    "bold-market": "POSTER",
    "editorial-studio": "COLLAGE",
    "architectural-escape": "ARCHITECTURAL",
    "everyday-boutique": "PHOTO_STRIP",
    "farm-and-market": "LANDSCAPE_BANNER",
  } as const;
  const titles = {
    "bold-market": "Good things. Great taste.",
    "editorial-studio": "Make it your own.",
    "architectural-escape": "A place for what's next.",
    "everyday-boutique": "Your next favorite.",
    "farm-and-market": "Rooted in our community.",
  };
  const hero = block(
    "HERO",
    {
      eyebrow: brand,
      title: titles[id],
      body: "Discover our collection and the story behind it.",
      mediaUrl: "",
      primaryLabel: resolvedGoal === "INQUIRY" ? "Explore offerings" : "Explore collection",
      primaryUrl: `#${collectionAnchor}`,
      secondaryLabel: "Get in touch",
      secondaryUrl: "#contact",
      missionText: "Discover what we offer, directly from our business.",
      media: id === "editorial-studio" ? media("studio-portrait") : undefined,
      stripMedia:
        id === "everyday-boutique"
          ? ["boutique-red", "boutique-dots", "boutique-pink", "boutique-sequin"].map((x) =>
              media(x as keyof typeof pack.assets),
            )
          : undefined,
      layers:
        id === "bold-market"
          ? [
              { id: "board", media: media("market-board"), depth: "SUBJECT" },
              { id: "herbs", media: media("market-herbs"), depth: "FOREGROUND" },
            ]
          : id === "editorial-studio"
            ? [{ id: "bag", media: media("studio-bag"), depth: "FOREGROUND" }]
            : undefined,
    },
    { layout: layouts[id], panelPlacement: "OVERLAP" },
    {
      preset: id === "everyday-boutique" || id === "farm-and-market" ? "REVEAL" : "PARALLAX",
      intensity: "SUBTLE",
      durationMs: 500,
      mobile: "STATIC",
    },
  );
  add("Welcome", "welcome", [hero], {
    layoutVariant: "HERO",
    contentWidth: id === "everyday-boutique" || id === "farm-and-market" ? "FULL" : "WIDE",
    padding: id === "everyday-boutique" ? "NONE" : "LARGE",
  });
  const catalogBlock = block(
    "CATALOG",
    {
      heading:
        id === "everyday-boutique"
          ? "Featured arrivals"
          : id === "farm-and-market"
            ? "Order from our collection"
            : "Explore the collection",
      body: "",
      catalogItemRefs: active
        .slice(0, 24)
        .map(({ sourceType, sourceId }) => ({ sourceType, sourceId })),
      columns: id === "everyday-boutique" ? 2 : 3,
      displayMode: id === "editorial-studio" ? "HORIZONTAL" : "VERTICAL",
    },
    {
      cardLayout: id === "everyday-boutique" ? "BOUTIQUE" : "STANDARD",
      showQuickView: true,
      showShopNow: id === "everyday-boutique",
      showAddToCart: true,
      orderPresentation: id === "farm-and-market" ? "INLINE_SUMMARY" : "DEFAULT",
      addLabel: "Add to cart",
      shopLabel: "Shop now",
      quickLabel: "Quick view",
    },
  );
  const features = () =>
    block("FEATURES", {
      heading: id === "farm-and-market" ? "Made for our community" : "Explore with confidence",
      items: [
        {
          id: randomUUID(),
          icon: "heart",
          title: "Our collection",
          body: "Discover the products and services we offer.",
        },
        {
          id: randomUUID(),
          icon: "package",
          title: "Your questions",
          body: "Contact us to find the option that suits you.",
        },
      ],
    });
  const story = (
    heading: string,
    ids: (keyof typeof pack.assets)[],
    layout: "STORY" | "PORTAL" | "LOOKBOOK",
    preset: "IMAGE_REVEAL" | "STICKY_STORY" = "IMAGE_REVEAL",
  ) =>
    block(
      "MEDIA_STORY",
      {
        heading,
        body: "Add your story, materials or details here.",
        frames: ids.map((x) => ({
          id: randomUUID(),
          media: media(x),
          caption: "",
          ...(active[0]
            ? { catalogRef: { sourceType: active[0].sourceType, sourceId: active[0].sourceId } }
            : {}),
        })),
        action: action("Explore more", collectionAnchor),
      },
      { layout },
      { preset, intensity: "SUBTLE", durationMs: 600, mobile: "STATIC" },
    );
  const offerings = block(
    "SHOWCASE",
    {
      heading: id === "farm-and-market" ? "Choose your path" : "Our offerings",
      body: "Discover the option that suits you.",
      items: active.slice(0, id === "farm-and-market" ? 3 : 6).map((i) => ({
        id: randomUUID(),
        title: i.name,
        body: "",
        media: i.mediaUrls[0]
          ? {
              url: i.mediaUrls[0],
              alt: i.name,
              focalPoint: { x: 0.5, y: 0.5 },
              aspectRatio: "LANDSCAPE",
            }
          : undefined,
        attributes: [],
        actions: [
          action(
            resolvedGoal === "SHOP" ? "Explore collection" : "Contact us",
            resolvedGoal === "SHOP" ? collectionAnchor : "contact",
          ),
        ],
      })),
    },
    {
      layout: id === "farm-and-market" ? "OFFERING_PATHS" : "GRID",
      showNumbers: id === "farm-and-market",
    },
    reveal,
  );
  if (id === "bold-market") {
    add("Highlights", "highlights", [features()], { padding: "SMALL" });
    add("Collection", collectionAnchor, [catalogBlock]);
    add("Our craft", "craft", [
      story("The details make the difference", ["market-craft"], "STORY"),
    ]);
    add("Serving story", "serving", [
      story("Made to be shared", ["market-hero", "market-craft"], "STORY", "STICKY_STORY"),
    ]);
  }
  if (id === "editorial-studio") {
    add("Lookbook", "lookbook", [
      story("Find your own rhythm", ["studio-portrait", "studio-linen"], "LOOKBOOK"),
    ]);
    add("Collection", collectionAnchor, [catalogBlock]);
    add("Materials", "materials", [story("A closer look", ["studio-material"], "STORY")]);
  }
  if (id === "architectural-escape") {
    add("Details", "details", [features()], { padding: "SMALL" });
    add("Inside and outside", "portal", [
      story(
        "See a different perspective",
        ["haven-3d-exterior", "haven-3d-interior", "haven-3d-courtyard"],
        "PORTAL",
      ),
    ]);
    add("Offerings", collectionAnchor, [offerings]);
    add("Gallery", "gallery", [
      block(
        "GALLERY",
        {
          heading: "Take a closer look",
          mediaUrls: [],
          media: ["haven-3d-exterior", "haven-3d-interior", "haven-3d-courtyard"].map((x) =>
            media(x as keyof typeof pack.assets),
          ),
          columns: 3,
        },
        { layout: "GRID" },
      ),
    ]);
  }
  if (id === "everyday-boutique") {
    add("Featured arrivals", collectionAnchor, [catalogBlock]);
    add("Highlights", "highlights", [features()], { padding: "SMALL" });
    add(
      "Customer stories",
      "testimonials",
      [block("TESTIMONIALS", { heading: "Customer stories", displayMode: "RAIL", entries: [] })],
      { backgroundColor: accentColor },
    );
    add("Collection close", "collection-close", [
      block("CTA", {
        heading: "Shop. Discover. Make it yours.",
        body: "",
        buttonLabel: "View full collection",
        buttonUrl: `#${collectionAnchor}`,
      }),
    ]);
  }
  if (id === "farm-and-market") {
    add("Offerings", "offerings", [offerings]);
    add("Our promise", "promise", [features()], { padding: "SMALL" });
    add("Order", collectionAnchor, [catalogBlock]);
  }
  if (id === "bold-market")
    add("Questions", "questions", [block("FAQ", { heading: "Your questions", items: [] })]);
  add("Contact", "contact", [contact]);
  add(
    "Footer",
    "site-footer",
    [block("FOOTER", { brand, statement: "Discover our collection.", legal: "", links: nav })],
    {
      padding: "LARGE",
      backgroundColor: primaryColor,
      textColor: id === "everyday-boutique" ? textColor : "#FFFFFF",
    },
  );
  return v.parse(landingPageVariantUpdateSchema, {
    name: definition.name,
    schemaVersion: 2,
    template: { id, revision: rev },
    goal: resolvedGoal,
    theme,
    commerce: {
      ...defaultLandingPageCommerceSettings,
      orderingEnabled: resolvedGoal === "SHOP",
      ...(id === "farm-and-market" ? { contactBlockId: contact.id } : {}),
    },
    sections,
  });
}
