import bcrypt from "bcryptjs";
import {
  Business,
  CashAccount,
  CatalogProduct,
  InventoryItem,
  LandingPage,
  User,
} from "../../src/models/index.js";
import { defaultLandingSections } from "../../src/services/landing-page-template.js";
import { defaultLandingPageCommerceSettings } from "../../src/validation/landing-page.js";

export const testCredentials = {
  email: "owner@example.test",
  password: "Test-owner-password-2026",
};
export async function seedBrowserFixtures() {
  const business = await Business.create({
    businessName: "Test Farm",
    businessNameNormalized: "test farm",
  });
  const user = await User.create({
    businessId: business._id,
    name: "Test Owner",
    email: testCredentials.email,
    emailNormalized: testCredentials.email,
    phone: "+639171234567",
    phoneNormalized: "+639171234567",
    passwordHash: await bcrypt.hash(testCredentials.password, 12),
    mpinHash: await bcrypt.hash("123456", 12),
    emailVerifiedAt: new Date(),
    isApproved: true,
    status: "ACTIVE",
    role: 0,
  });
  business.ownerUserId = user._id;
  await business.save();
  const account = await CashAccount.create({
    businessId: business._id,
    accountCode: "TEST-CASH",
    name: "Test cash",
    accountType: "CASH",
    openingBalance: "10000",
    currentBalanceCached: "10000",
  });
  const inventory = await InventoryItem.create({
    businessId: business._id,
    itemCode: "TEST-FEED",
    name: "Test feed",
    businessUnit: "PIGGERY",
    category: "FEED",
    baseUnit: "KG",
  });
  const products = [];
  for (let index = 0; index < 24; index++)
    products.push(
      await CatalogProduct.create({
        businessId: business._id,
        productCode: `TEST-${index}`,
        name: `Farm product ${index + 1}`,
        category: "Farm products",
        description: "A reproducible catalog item for browser and performance testing.",
        basePrice: 100 + index,
        availableQuantity: 1000,
      }),
    );
  const sections = defaultLandingSections(
    business,
    products.map((product) => ({
      sourceType: "PRODUCT" as const,
      sourceId: product.id,
      name: product.name,
      isAvailable: true,
      isFeatured: false,
      mediaUrls: [],
    })),
  );
  const theme = {
    primaryColor: "#9d174d",
    backgroundColor: "#fff7f9",
    surfaceColor: "#ffffff",
    textColor: "#292524",
    fontStyle: "MODERN",
    buttonStyle: "ROUNDED",
  };
  await LandingPage.create({
    businessId: business._id,
    slug: "test-farm",
    siteTitle: "Test Farm",
    seoDescription: "Browse farm products from Test Farm.",
    isPublished: true,
    publishedAt: new Date("2026-09-01T00:00:00Z"),
    publishedSnapshot: {
      name: "Published test fixture",
      siteTitle: "Test Farm",
      seoDescription: "Browse farm products from Test Farm.",
      theme,
      commerce: defaultLandingPageCommerceSettings,
      sections,
    },
  });
  return { business, user, account, inventory, products };
}
