import { type Request, type RequestHandler, Router } from "express";
import mongoose from "mongoose";
import * as v from "valibot";
import { assertImageReferences } from "../images/references.js";
import { HttpError } from "../lib/http-error.js";
import { availabilityInfo } from "../lib/product-availability.js";
import { getOwner } from "../middleware/auth.js";
import {
  Business,
  CatalogProduct,
  LandingPage,
  LandingPageSavedTemplate,
  LandingPageVariant,
} from "../models/index.js";
import { catalogCategories } from "../services/catalog-category.service.js";
import {
  getBuilderCatalogItems,
  getLandingMenuItems,
  getPublishedCatalogItems,
  hasEnabledCatalog,
} from "../services/commerce.service.js";
import {
  idempotent,
  ownedPage,
  parseSlug,
  revisionFilter,
} from "../services/landing-management.service.js";
import { createSection, defaultLandingSections } from "../services/landing-page-template.js";
import {
  createLandingPreset,
  landingScenes,
  landingTemplates,
} from "../services/landing-presets.js";
import { assertLandingCatalogReferences } from "../services/landing-references.js";
import {
  defaultLandingPageCommerceSettings,
  type LandingPageVariantInput,
  landingPageCommerceSettingsSchema,
  landingPageSettingsSchema,
  landingPageVariantCreateSchema,
  landingPageVariantUpdateSchema,
} from "../validation/landing-page.js";
import { landingManagementRouter } from "./landing-management.routes.js";

export const landingPageRouter = Router();
export const landingPagePublicRouter = Router();
const pageRoutes = Router({ mergeParams: true });
landingPageRouter.use(landingManagementRouter);

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
    schemaVersion: source.schemaVersion ?? 1,
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

async function builderPayload(businessId: mongoose.Types.ObjectId, request: Request) {
  let page: any;
  try {
    page = (await ownedPage(request)).toObject();
  } catch (error) {
    if (request.params.pageId || !(error instanceof HttpError) || error.status !== 404) throw error;
  }
  if (page) await catalogCategories(businessId);
  const [variants, menuItems, catalogItems] = await Promise.all([
    page
      ? LandingPageVariant.find({ businessId, landingPageId: page._id })
          .sort({ createdAt: 1 })
          .lean()
      : [],
    getLandingMenuItems(businessId),
    getBuilderCatalogItems(businessId),
  ]);
  const normalizedVariants = variants.map((variant) => serializedVariant(variant));
  return {
    page,
    variants: normalizedVariants,
    menuItems,
    catalogItems,
    capabilities: {
      schemaVersions: [1, 2],
      templates: process.env.LANDING_V2_TEMPLATES !== "false",
      multiplePages: true,
      categoryBinding: true,
      schedules: true,
      savedTemplates: true,
    },
  };
}

landingPageRouter.get("/templates", (_request, response) => {
  response.json({
    templates: process.env.LANDING_V2_TEMPLATES === "false" ? [] : landingTemplates,
    scenes: landingScenes,
    schemaVersion: 2,
  });
});

pageRoutes.get("/", async (request, response) => {
  response.json(await builderPayload(getOwner(request).businessId, request));
});

landingPageRouter.post("/", async (request, response) => {
  const owner = getOwner(request);
  const existing = await LandingPage.findOne({ businessId: owner.businessId });
  if (existing) return response.json(await builderPayload(owner.businessId, request));
  const business = await Business.findById(owner.businessId).lean();
  if (!business) throw new HttpError(404, "Business was not found");
  const page = await LandingPage.create({
    businessId: owner.businessId,
    isLegacyDefault: true,
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
  response.status(201).json(await builderPayload(owner.businessId, request));
});

pageRoutes.patch("/settings", async (request: Request, response) => {
  const owner = getOwner(request);
  const input = v.parse(landingPageSettingsSchema, request.body);
  const page = await ownedPage(request);
  input.slug = parseSlug(input.slug);
  if (request.params.pageId && request.body.expectedPageRevision !== (page.revision ?? 1))
    throw new HttpError(
      409,
      "Page settings changed; reload before saving",
      undefined,
      "PAGE_REVISION_CONFLICT",
    );
  const collision = await LandingPage.exists({ _id: { $ne: page._id }, slug: input.slug });
  if (collision)
    throw new HttpError(409, "This subdomain is already taken", undefined, "SUBDOMAIN_TAKEN");
  page.slug = input.slug;
  page.siteTitle = input.siteTitle;
  page.seoDescription = input.seoDescription;
  const name = v.parse(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
    request.body.name ?? page.name ?? page.siteTitle,
  );
  let updated: any;
  try {
    updated = await LandingPage.findOneAndUpdate(
      { _id: page._id, businessId: owner.businessId, ...revisionFilter(page.revision ?? 1) },
      { $set: { ...input, name }, $inc: { revision: 1 } },
      { new: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      throw new HttpError(409, "This subdomain is already taken", undefined, "SUBDOMAIN_TAKEN");
    throw error;
  }
  if (!updated)
    throw new HttpError(
      409,
      "Page settings changed; reload before saving",
      undefined,
      "PAGE_REVISION_CONFLICT",
    );
  response.json(updated.toObject());
});

pageRoutes.post("/variants", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(landingPageVariantCreateSchema, request.body);
  const page = await ownedPage(request);
  let savedTemplate: any;
  if (request.body.savedTemplateId) {
    if (!mongoose.isValidObjectId(request.body.savedTemplateId))
      throw new HttpError(422, "Invalid saved template id");
    savedTemplate = await LandingPageSavedTemplate.findOne({
      _id: request.body.savedTemplateId,
      businessId: owner.businessId,
    }).lean();
    if (!savedTemplate) throw new HttpError(404, "Saved template was not found");
  }
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
  if (input.templateId && process.env.LANDING_V2_TEMPLATES === "false")
    throw new HttpError(409, "New templates are temporarily unavailable");
  const preset =
    savedTemplate?.document ??
    (input.templateId
      ? createLandingPreset(
          input.templateId,
          input.templateRevision,
          input.goal,
          await Business.findById(owner.businessId).lean(),
          await getBuilderCatalogItems(owner.businessId),
        )
      : null);
  if (preset) {
    if (!savedTemplate) {
      for (const section of preset.sections)
        for (const block of section.components)
          if (block.type === "CATALOG" || block.type === "MENU") {
            block.content.categoryBinding = { mode: "ALL_CATEGORIES" };
            if (block.type === "CATALOG") block.content.catalogItemRefs = [];
            else block.content.menuItemIds = [];
          }
      preset.categoryBindingVersion = 1;
    }
    await assertImageReferences(preset, owner.businessId);
    await assertLandingCatalogReferences(preset, owner.businessId);
  }
  if (duplicate) {
    await assertImageReferences(duplicate, owner.businessId);
    await assertLandingCatalogReferences(duplicate, owner.businessId);
  }
  const variant = await LandingPageVariant.create({
    businessId: owner.businessId,
    landingPageId: page._id,
    name: input.name,
    sourceSavedTemplateId: savedTemplate?._id ?? duplicate?.sourceSavedTemplateId,
    sourceSavedTemplateRevision: savedTemplate?.revision ?? duplicate?.sourceSavedTemplateRevision,
    categoryBindingVersion: preset?.categoryBindingVersion ?? duplicate?.categoryBindingVersion,
    schemaVersion: preset?.schemaVersion ?? duplicate?.schemaVersion ?? 1,
    template: preset?.template ?? duplicate?.template,
    goal: preset?.goal ?? duplicate?.goal,
    theme: preset?.theme ?? duplicate?.theme ?? defaultTheme,
    commerce: preset?.commerce ?? duplicate?.commerce ?? defaultLandingPageCommerceSettings,
    sections:
      preset?.sections ??
      (duplicate
        ? normalizedSections(duplicate)
        : defaultLandingSections(
            await Business.findById(owner.businessId).lean(),
            await getBuilderCatalogItems(owner.businessId),
          )),
    createdByUserId: owner.userId,
    updatedByUserId: owner.userId,
  });
  response.status(201).json(serializedVariant(variant.toObject()));
});

pageRoutes.patch("/variants/:id", async (request: Request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid variant id");
  const current = await LandingPageVariant.findOne({
    _id: request.params.id,
    businessId: owner.businessId,
    ...(request.params.pageId ? { landingPageId: request.params.pageId } : {}),
  }).lean();
  if (!current) throw new HttpError(404, "Landing-page variant was not found");
  const page = await ownedPage(request);
  if (String(current.landingPageId) !== String(page._id))
    throw new HttpError(404, "Landing-page variant was not found");
  if (current.categoryBindingVersion && !request.body.categoryBindingVersion)
    throw new HttpError(
      409,
      "Upgrade your editor to preserve category selections",
      undefined,
      "UPGRADE_REQUIRED",
    );
  if (request.params.pageId && request.body.expectedRevision !== (current.revision ?? 1))
    throw new HttpError(
      409,
      "Draft changed in another editor; reload before saving",
      undefined,
      "DRAFT_REVISION_CONFLICT",
    );
  if (current.schemaVersion === 2 && request.body.schemaVersion !== 2)
    throw new HttpError(
      409,
      "Upgrade your editor to edit this design",
      undefined,
      "UPGRADE_REQUIRED",
    );
  if (current.schemaVersion !== 2 && request.body.schemaVersion === 2)
    throw new HttpError(
      409,
      "Upgrade as a new variant to preserve the original",
      undefined,
      "UPGRADE_REQUIRED",
    );
  const input = v.parse(landingPageVariantUpdateSchema, {
    ...request.body,
    sections: normalizedSections(request.body),
  });
  await assertImageReferences(input, owner.businessId);
  await assertLandingCatalogReferences(input, owner.businessId);
  const variant = await LandingPageVariant.findOneAndUpdate(
    {
      _id: request.params.id,
      businessId: owner.businessId,
      landingPageId: page._id,
      ...revisionFilter(current.revision ?? 1),
      schemaVersion: current.schemaVersion === 2 ? 2 : { $ne: 2 },
    },
    {
      $set: { ...input, updatedByUserId: owner.userId },
      $unset: { components: 1 },
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true },
  );
  if (!variant)
    throw new HttpError(
      409,
      "Draft changed in another editor; reload before saving",
      undefined,
      "DRAFT_REVISION_CONFLICT",
    );
  response.json(serializedVariant(variant.toObject()));
});

pageRoutes.patch("/variants/:id/reset", async (request: Request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid variant id");
  const page = await ownedPage(request);
  const variant = await LandingPageVariant.findOne({
    _id: request.params.id,
    landingPageId: page._id,
    businessId: owner.businessId,
  });
  if (!variant) throw new HttpError(404, "Landing-page variant was not found");
  const originalRevision = variant.revision ?? 1;
  if (request.params.pageId && request.body.expectedRevision !== originalRevision)
    throw new HttpError(
      409,
      "Draft changed; reload before resetting",
      undefined,
      "DRAFT_REVISION_CONFLICT",
    );
  const [business, catalogItems] = await Promise.all([
    Business.findById(owner.businessId).lean(),
    getBuilderCatalogItems(owner.businessId),
  ]);
  if (variant.schemaVersion === 2 && variant.template) {
    const preset = createLandingPreset(
      variant.template.id,
      variant.template.revision,
      variant.goal,
      business,
      catalogItems,
    );
    await assertImageReferences(preset, owner.businessId);
    await assertLandingCatalogReferences(preset, owner.businessId);
    variant.theme = preset.theme;
    variant.commerce = preset.commerce;
    variant.sections = preset.sections;
    variant.goal = preset.goal;
  } else {
    variant.theme = defaultTheme;
    variant.commerce = defaultLandingPageCommerceSettings;
    variant.sections = defaultLandingSections(business, catalogItems);
  }
  variant.set("components", undefined);
  variant.updatedByUserId = owner.userId;
  if (variant.categoryBindingVersion) {
    for (const section of variant.sections)
      for (const block of section.components)
        if (block.type === "CATALOG" || block.type === "MENU") {
          block.content.categoryBinding = { mode: "ALL_CATEGORIES" };
          if (block.type === "CATALOG") block.content.catalogItemRefs = [];
          else block.content.menuItemIds = [];
        }
  }
  if (request.params.pageId) {
    const updated = await LandingPageVariant.findOneAndUpdate(
      {
        _id: variant._id,
        businessId: owner.businessId,
        landingPageId: page._id,
        ...revisionFilter(originalRevision),
      },
      {
        $set: {
          theme: variant.theme,
          commerce: variant.commerce,
          sections: variant.sections,
          goal: variant.goal,
          updatedByUserId: owner.userId,
        },
        $unset: { components: 1 },
        $inc: { revision: 1 },
      },
      { new: true },
    );
    if (!updated)
      throw new HttpError(
        409,
        "Draft changed; reload before resetting",
        undefined,
        "DRAFT_REVISION_CONFLICT",
      );
    response.json(serializedVariant(updated.toObject()));
    return;
  }
  variant.revision = originalRevision + 1;
  await variant.save();
  response.json(serializedVariant(variant.toObject()));
});

pageRoutes.delete("/variants/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid variant id");
  const page = await ownedPage(request);
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

const publishVariant: RequestHandler = async (request, response) => {
  const owner = getOwner(request);
  const variantId = request.params.id ?? request.body.variantId;
  if (!mongoose.isValidObjectId(variantId)) throw new HttpError(400, "Invalid variant id");
  const publish = async () => {
    const [page, variant] = await Promise.all([
      ownedPage(request),
      LandingPageVariant.findOne({ _id: variantId, businessId: owner.businessId }).lean(),
    ]);
    if (!variant) throw new HttpError(404, "Landing-page variant was not found");
    if (String(variant.landingPageId) !== String(page._id))
      throw new HttpError(404, "Landing-page variant was not found");
    if (
      request.params.pageId &&
      (request.body.expectedVariantRevision !== (variant.revision ?? 1) ||
        request.body.expectedPageRevision !== (page.revision ?? 1))
    )
      throw new HttpError(
        409,
        "The page or draft changed. Reload before publishing.",
        undefined,
        "PAGE_REVISION_CONFLICT",
      );
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
    await assertImageReferences(input, owner.businessId);
    await assertLandingCatalogReferences(input, owner.businessId);
    page.isPublished = true;
    page.publishedVariantId = variant._id;
    page.publishedSnapshot = {
      variantId: String(variant._id),
      name: input.name,
      schemaVersion: input.schemaVersion ?? 1,
      categoryBindingVersion: input.categoryBindingVersion,
      template: input.template,
      goal: input.goal,
      theme: input.theme,
      commerce: input.commerce,
      sections: input.sections,
      siteTitle: page.siteTitle,
      seoDescription: page.seoDescription,
    };
    page.publishedAt = new Date();
    page.publishedByUserId = owner.userId;
    page.publishedSourceVariantRevision = variant.revision ?? 1;
    if (!request.params.pageId) {
      page.revision = (page.revision ?? 1) + 1;
      await page.save();
      return page.toObject();
    }
    const updated = await LandingPage.findOneAndUpdate(
      { _id: page._id, businessId: owner.businessId, ...revisionFilter(page.revision ?? 1) },
      {
        $set: {
          isPublished: true,
          publishedVariantId: variant._id,
          publishedSnapshot: page.publishedSnapshot,
          publishedAt: page.publishedAt,
          publishedByUserId: owner.userId,
          publishedSourceVariantRevision: variant.revision ?? 1,
        },
        $inc: { revision: 1 },
      },
      { new: true },
    );
    if (!updated)
      throw new HttpError(
        409,
        "Publication changed; reload before retrying",
        undefined,
        "PAGE_REVISION_CONFLICT",
      );
    return updated.toObject();
  };
  response.json(
    request.params.pageId
      ? await idempotent(
          owner.businessId,
          request.get("Idempotency-Key"),
          `publish:${request.params.pageId}`,
          request.body,
          publish,
        )
      : await publish(),
  );
};
pageRoutes.post("/variants/:id/publish", publishVariant);
pageRoutes.post("/publish", publishVariant);

pageRoutes.post("/unpublish", async (request: Request, response) => {
  const page = await ownedPage(request);
  if (request.params.pageId) {
    if (request.body.expectedPageRevision !== (page.revision ?? 1))
      throw new HttpError(
        409,
        "Page changed; reload before unpublishing",
        undefined,
        "PAGE_REVISION_CONFLICT",
      );
    const updated = await LandingPage.findOneAndUpdate(
      {
        _id: page._id,
        businessId: getOwner(request).businessId,
        ...revisionFilter(page.revision ?? 1),
      },
      {
        $set: { isPublished: false, publishedSnapshot: null, publishedAt: null },
        $unset: { publishedVariantId: 1, publishedByUserId: 1, publishedSourceVariantRevision: 1 },
        $inc: { revision: 1 },
      },
      { new: true },
    );
    if (!updated)
      throw new HttpError(
        409,
        "Page changed; reload before unpublishing",
        undefined,
        "PAGE_REVISION_CONFLICT",
      );
    response.json(updated.toObject());
    return;
  }
  page.isPublished = false;
  page.publishedVariantId = undefined;
  page.publishedSnapshot = null;
  page.publishedAt = null;
  page.publishedByUserId = undefined;
  page.revision = (page.revision ?? 1) + 1;
  await page.save();
  response.json(page);
});

landingPageRouter.use("/pages/:pageId", pageRoutes);
landingPageRouter.use(pageRoutes);

landingPagePublicRouter.get("/landing-pages/:slug", async (request, response) => {
  const page = await LandingPage.findOne({
    slug: request.params.slug.toLowerCase(),
    isPublished: true,
    publishedSnapshot: { $ne: null },
    isArchived: { $ne: true },
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
  const now = new Date();
  const catalogItems = await getPublishedCatalogItems(
    page.businessId,
    { ...snapshot, sections },
    now,
  );
  const products = await CatalogProduct.find({ businessId: page.businessId, isActive: true })
    .select("availabilitySchedule isActive")
    .lean();
  const transitions = products
    .map((p) => availabilityInfo(p, now).nextTransitionAt)
    .filter((time): time is string => Boolean(time))
    .sort();
  const allowedMenuIds = new Set(
    catalogItems.filter((item) => item.sourceType === "MENU_ITEM").map((item) => item.sourceId),
  );
  response.set("Cache-Control", "no-store");
  response.json({
    slug: page.slug,
    pageId: String(page._id),
    businessId: String(page.businessId),
    nextTransitionAt: transitions[0] ?? null,
    serverTime: now.toISOString(),
    siteTitle: snapshot.siteTitle,
    seoDescription: snapshot.seoDescription,
    publishedAt: page.publishedAt,
    variant: {
      schemaVersion: snapshot.schemaVersion ?? 1,
      template: snapshot.template,
      goal: snapshot.goal,
      theme: snapshot.theme,
      commerce,
      sections,
      components: (sections as Array<{ components: unknown[] }>).flatMap(
        (section) => section.components,
      ),
    },
    menuItems: menuItems.filter((item) => allowedMenuIds.has(String(item._id))),
    catalogItems,
  });
});
