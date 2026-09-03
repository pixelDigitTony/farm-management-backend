import { randomUUID } from "node:crypto";
import type { LandingPageVariantInput } from "../validation/landing-page.js";

type Section = LandingPageVariantInput["sections"][number];
type TemplateCatalogItem = {
  sourceType: "MENU_ITEM" | "PRODUCT";
  sourceId: string;
  name: string;
  isAvailable: boolean;
  isFeatured: boolean;
  mediaUrls: string[];
};
type TemplateBusiness = {
  businessName?: string;
  karenderiya?: { address?: string };
  piggery?: { address?: string };
};

export function createSection(
  name: string,
  components: Section["components"],
  options: Partial<Section> = {},
): Section {
  return {
    id: randomUUID(),
    name,
    enabled: true,
    backgroundColor: "",
    textColor: "",
    contentWidth: "WIDE",
    padding: "MEDIUM",
    gap: "MEDIUM",
    maxHeight: 0,
    components,
    ...options,
  };
}

export function defaultLandingSections(
  business: TemplateBusiness | null,
  catalogItems: TemplateCatalogItem[],
): Section[] {
  const businessName = business?.businessName || "Our business";
  const available = catalogItems
    .filter((item) => item.isAvailable)
    .sort(
      (left, right) =>
        Number(right.isFeatured) - Number(left.isFeatured) || left.name.localeCompare(right.name),
    );
  const menus = available.filter((item) => item.sourceType === "MENU_ITEM").slice(0, 12);
  const products = available.filter((item) => item.sourceType === "PRODUCT").slice(0, 24);
  const media = [...new Set([...products, ...menus].flatMap((item) => item.mediaUrls))]
    .filter((url) => /^https:\/\//i.test(url) && url.length <= 1000)
    .slice(0, 6);
  const primaryUrl = products.length ? "#products" : "#menu";
  const primaryLabel = products.length ? "Shop our products" : "View our menu";
  const base = () => ({ id: randomUUID(), enabled: true, width: "FULL" as const });
  return [
    createSection(
      "Welcome",
      [
        {
          ...base(),
          type: "HERO",
          content: {
            eyebrow: "Welcome to our business",
            title: businessName.slice(0, 120),
            body: "Explore our menu and products, choose your favorites, and place an order for pickup or delivery.",
            mediaUrl: media[0] ?? "",
            primaryLabel,
            primaryUrl,
            secondaryLabel: "Contact us",
            secondaryUrl: "#contact",
          },
        },
      ],
      { padding: "LARGE" },
    ),
    createSection(
      "Our story",
      [
        {
          ...base(),
          type: "TEXT",
          content: {
            heading: "Made for our community",
            body: `Welcome to ${businessName}. Browse what is available today and contact us if you have a question about your order.`,
            alignment: "CENTER",
          },
        },
      ],
      { contentWidth: "CONTAINED" },
    ),
    createSection(
      "Featured menu",
      [
        {
          ...base(),
          type: "MENU",
          content: {
            heading: "Featured menu",
            body: "Choose your favorites and add them to your cart.",
            menuItemIds: menus.map((item) => item.sourceId),
            columns: 3,
            displayMode: "VERTICAL",
          },
        },
      ],
      { maxHeight: 640, enabled: menus.length > 0 || !products.length },
    ),
    createSection(
      "Featured products",
      [
        {
          ...base(),
          type: "CATALOG",
          content: {
            heading: "Featured products",
            body: "Browse our latest products and choose the options that suit you.",
            catalogItemRefs: products.map(({ sourceType, sourceId }) => ({ sourceType, sourceId })),
            columns: 3,
            displayMode: "HORIZONTAL",
          },
        },
      ],
      { maxHeight: 640, backgroundColor: "#ffffff", enabled: products.length > 0 || !menus.length },
    ),
    ...(media.length
      ? [
          createSection(
            "Gallery",
            [
              {
                ...base(),
                type: "GALLERY",
                content: { heading: "A closer look", mediaUrls: media, columns: 3 },
              },
            ],
            { maxHeight: 640 },
          ),
        ]
      : []),
    createSection("Order with us", [
      {
        ...base(),
        type: "CTA",
        content: {
          heading: "Ready to order?",
          body: "Add your favorites to the cart, then choose pickup or delivery at checkout.",
          buttonLabel: primaryLabel,
          buttonUrl: primaryUrl,
        },
      },
    ]),
    createSection(
      "Contact",
      [
        {
          ...base(),
          type: "CONTACT",
          content: {
            heading: "Visit or contact us",
            body: "Have a question? We would love to hear from you.",
            address: (business?.karenderiya?.address || business?.piggery?.address || "").slice(
              0,
              300,
            ),
            phone: "",
            email: "",
            hours: "",
            facebookUrl: "",
            instagramUrl: "",
            mapUrl: "",
          },
        },
      ],
      { padding: "LARGE" },
    ),
  ];
}
