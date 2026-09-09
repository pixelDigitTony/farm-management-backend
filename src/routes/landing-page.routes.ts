import { Router } from "express";
import mongoose from "mongoose";
import * as v from "valibot";
import { HttpError } from "../lib/http-error.js";
import { getOwner } from "../middleware/auth.js";
import { Business, LandingPage, LandingPageVariant } from "../models/index.js";
import {
  getBuilderCatalogItems,
  getLandingMenuItems,
  getPublishedCatalogItems,
  hasEnabledCatalog,
} from "../services/commerce.service.js";
import { createSection, defaultLandingSections } from "../services/landing-page-template.js";
import {
  defaultLandingPageCommerceSettings,
  type LandingPageVariantInput,
  landingPageCommerceSettingsSchema,
  landingPageSettingsSchema,
  landingPageVariantCreateSchema,
  landingPageVariantUpdateSchema,
} from "../validation/landing-page.js";

export const landingPageRouter = Router();
export const landingPagePublicRouter = Router();

const defaultTheme = {
  primaryColor: "#be185d",
  backgroundColor: "#fff7fb",
  surfaceColor: "#ffffff",
  textColor: "#292524",
  fontStyle: "CLASSIC",
  buttonStyle: "ROUNDED",
};

function normalizedSections(source: { sections?: unknown; components?: unknown }) {
  if (Array.isArray(source.sections) && source.sections.length) return source.sections;
  const components = Array.isArray(source.components) ? source.components : [];
  return [createSection("Main section", components)];
}

function serializedVariant(source: Record<string, unknown>) {
  const sections = normalizedSections(source) as Array<{ components: unknown[] }>;
  const { components: _legacyComponents, ...rest } = source;
  return {
    ...rest,
    commerce: source.commerce ?? defaultLandingPageCommerceSettings,
    sections,
    // Temporary compatibility for a frontend deployed before section support.
    components: sections.flatMap((section) => section.components),
  };
}

async function createSlug(name: string) {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 54);
  const root = base && !["api", "app", "www"].includes(base) ? base : "business";
  let candidate = root;
  let suffix = 2;
  while (await LandingPage.exists({ slug: candidate })) {
    candidate = `${root.slice(0, 56 - String(suffix).length)}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function getPage(businessId: mongoose.Types.ObjectId) {
  const page = await LandingPage.findOne({ businessId });
  if (!page) throw new HttpError(404, "Initialize the landing page first");
  return page;
}

async function builderPayload(businessId: mongoose.Types.ObjectId) {
  const [page, variants, menuItems, catalogItems] = await Promise.all([
    LandingPage.findOne({ businessId }).lean(),
    LandingPageVariant.find({ businessId }).sort({ createdAt: 1 }).lean(),
    getLandingMenuItems(businessId),
    getBuilderCatalogItems(businessId),
  ]);
  const normalizedVariants = variants.map((variant) => serializedVariant(variant));
  return { page, variants: normalizedVariants, menuItems, catalogItems };
}

landingPageRouter.get("/", async (request, response) => {
  response.json(await builderPayload(getOwner(request).businessId));
});

landingPageRouter.post("/", async (request, response) => {
  const owner = getOwner(request);
  const existing = await LandingPage.findOne({ businessId: owner.businessId });
  if (existing) return response.json(await builderPayload(owner.businessId));
  const business = await Business.findById(owner.businessId).lean();
  if (!business) throw new HttpError(404, "Business was not found");
  const page = await LandingPage.create({
    businessId: owner.businessId,
    slug: await createSlug(business.businessName),
    siteTitle: business.businessName,
    seoDescription: `${business.businessName} public landing page`,
  });
  try {
    await LandingPageVariant.create({
      businessId: owner.businessId,
      landingPageId: page._id,
      name: "Main",
      theme: defaultTheme,
      commerce: defaultLandingPageCommerceSettings,
      sections: defaultLandingSections(business, await getBuilderCatalogItems(owner.businessId)),
      createdByUserId: owner.userId,
      updatedByUserId: owner.userId,
    });
  } catch (error) {
    await page.deleteOne();
    throw error;
  }
  response.status(201).json(await builderPayload(owner.businessId));
});

landingPageRouter.patch("/settings", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(landingPageSettingsSchema, request.body);
  const page = await getPage(owner.businessId);
  const collision = await LandingPage.exists({ _id: { $ne: page._id }, slug: input.slug });
  if (collision) throw new HttpError(409, "That public page address is already in use");
  page.slug = input.slug;
  page.siteTitle = input.siteTitle;
  page.seoDescription = input.seoDescription;
  await page.save();
  response.json(page);
});

landingPageRouter.post("/variants", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(landingPageVariantCreateSchema, request.body);
  const page = await getPage(owner.businessId);
  if (input.duplicateFromId && !mongoose.isValidObjectId(input.duplicateFromId))
    throw new HttpError(422, "Select a valid source variant");
  const duplicate = input.duplicateFromId
    ? await LandingPageVariant.findOne({
        _id: input.duplicateFromId,
        landingPageId: page._id,
        businessId: owner.businessId,
      }).lean()
    : null;
  if (input.duplicateFromId && !duplicate)
    throw new HttpError(404, "The source variant was not found");
  const variant = await LandingPageVariant.create({
    businessId: owner.businessId,
    landingPageId: page._id,
    name: input.name,
    theme: duplicate?.theme ?? defaultTheme,
    commerce: duplicate?.commerce ?? defaultLandingPageCommerceSettings,
    sections: duplicate
      ? normalizedSections(duplicate)
      : defaultLandingSections(
          await Business.findById(owner.businessId).lean(),
          await getBuilderCatalogItems(owner.businessId),
        ),
    createdByUserId: owner.userId,
    updatedByUserId: owner.userId,
  });
  response.status(201).json(serializedVariant(variant.toObject()));
});

landingPageRouter.patch("/variants/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid variant id");
  const input = v.parse(landingPageVariantUpdateSchema, {
    ...request.body,
    sections: normalizedSections(request.body),
  });
  const variant = await LandingPageVariant.findOneAndUpdate(
    { _id: request.params.id, businessId: owner.businessId },
    {
      $set: { ...input, updatedByUserId: owner.userId },
      $unset: { components: 1 },
    },
    { new: true, runValidators: true },
  );
  if (!variant) throw new HttpError(404, "Landing-page variant was not found");
  response.json(serializedVariant(variant.toObject()));
});

landingPageRouter.delete("/variants/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid variant id");
  const page = await getPage(owner.businessId);
  if (String(page.publishedVariantId) === request.params.id)
    throw new HttpError(409, "Publish another variant or unpublish before deleting this one");
  const count = await LandingPageVariant.countDocuments({ landingPageId: page._id });
  if (count <= 1) throw new HttpError(409, "Keep at least one landing-page variant");
  const result = await LandingPageVariant.deleteOne({
    _id: request.params.id,
    landingPageId: page._id,
    businessId: owner.businessId,
  });
  if (!result.deletedCount) throw new HttpError(404, "Landing-page variant was not found");
  response.status(204).send();
});

landingPageRouter.post("/variants/:id/publish", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid variant id");
  const [page, variant] = await Promise.all([
    getPage(owner.businessId),
    LandingPageVariant.findOne({ _id: request.params.id, businessId: owner.businessId }).lean(),
  ]);
  if (!variant) throw new HttpError(404, "Landing-page variant was not found");
  const input = v.parse(landingPageVariantUpdateSchema, {
    ...variant,
    sections: normalizedSections(variant),
  });
  if (
    !input.sections.some(
      (section) => section.enabled && section.components.some((component) => component.enabled),
    )
  )
    throw new HttpError(422, "Show at least one component before publishing");
  page.isPublished = true;
  page.publishedVariantId = variant._id;
  page.publishedSnapshot = {
    variantId: String(variant._id),
    name: input.name,
    theme: input.theme,
    commerce: input.commerce,
    sections: input.sections,
    siteTitle: page.siteTitle,
    seoDescription: page.seoDescription,
  };
  page.publishedAt = new Date();
  page.publishedByUserId = owner.userId;
  await page.save();
  response.json(page);
});

landingPageRouter.post("/unpublish", async (request, response) => {
  const owner = getOwner(request);
  const page = await getPage(owner.businessId);
  page.isPublished = false;
  page.publishedVariantId = undefined;
  page.publishedSnapshot = null;
  page.publishedAt = null;
  page.publishedByUserId = undefined;
  await page.save();
  response.json(page);
});

landingPagePublicRouter.get("/landing-pages/:slug", async (request, response) => {
  const page = await LandingPage.findOne({
    slug: request.params.slug.toLowerCase(),
    isPublished: true,
    publishedSnapshot: { $ne: null },
  }).lean();
  if (!page) throw new HttpError(404, "Published page was not found");
  const business = await Business.exists({ _id: page.businessId, isArchived: { $ne: true } });
  if (!business) throw new HttpError(404, "Published page was not found");
  const snapshot = page.publishedSnapshot as LandingPageVariantInput & {
    siteTitle: string;
    seoDescription: string;
  };
  const commerce = v.parse(
    landingPageCommerceSettingsSchema,
    snapshot.commerce ?? defaultLandingPageCommerceSettings,
  );
  const sections = normalizedSections(snapshot);
  const menuItems = hasEnabledCatalog({ sections }, "MENU")
    ? await getLandingMenuItems(page.businessId)
    : [];
  const catalogItems = await getPublishedCatalogItems(page.businessId, { sections });
  response.set("Cache-Control", "no-store");
  response.json({
    slug: page.slug,
    serverTime: new Date().toISOString(),
    siteTitle: snapshot.siteTitle,
    seoDescription: snapshot.seoDescription,
    publishedAt: page.publishedAt,
    variant: {
      theme: snapshot.theme,
      commerce,
      sections,
      components: (sections as Array<{ components: unknown[] }>).flatMap(
        (section) => section.components,
      ),
    },
    menuItems,
    catalogItems,
  });
});
