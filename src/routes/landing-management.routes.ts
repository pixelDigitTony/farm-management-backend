import { Router } from "express";
import mongoose from "mongoose";
import * as v from "valibot";
import { assertImageReferences } from "../images/references.js";
import { HttpError } from "../lib/http-error.js";
import { getOwner } from "../middleware/auth.js";
import {
  CatalogProduct,
  LandingPage,
  LandingPageSavedTemplate,
  LandingPageVariant,
  MenuItem,
} from "../models/index.js";
import { catalogCategories } from "../services/catalog-category.service.js";
import {
  createPage,
  idempotent,
  ownedPage,
  parseSlug,
  revisionFilter,
  slugReserved,
} from "../services/landing-management.service.js";
import { assertLandingCatalogReferences } from "../services/landing-references.js";
import { landingPageVariantUpdateSchema } from "../validation/landing-page.js";

export const landingManagementRouter = Router();
landingManagementRouter.get("/categories", async (request, response) =>
  response.json({ items: await catalogCategories(getOwner(request).businessId) }),
);
landingManagementRouter.get("/category-conversion", async (request, response) => {
  const { businessId } = getOwner(request);
  if (!mongoose.isValidObjectId(request.query.variantId))
    throw new HttpError(422, "Choose a valid draft");
  const variant = await LandingPageVariant.findOne({
    _id: request.query.variantId,
    businessId,
  }).lean();
  if (!variant) throw new HttpError(404, "Draft was not found");
  const block = variant.sections
    .flatMap((s: any) => s.components)
    .find((b: any) => b.id === request.query.blockId);
  if (!block || !["CATALOG", "MENU"].includes(block.type))
    throw new HttpError(422, "Choose a catalog block");
  await catalogCategories(businessId);
  const refs =
    block.type === "MENU"
      ? block.content.menuItemIds.map((id: string) => ({ sourceType: "MENU_ITEM", sourceId: id }))
      : block.content.catalogItemRefs;
  const ids: string[] = [];
  let found = 0;
  for (const type of ["PRODUCT", "MENU_ITEM"]) {
    const selected = refs.filter((r: any) => r.sourceType === type).map((r: any) => r.sourceId);
    const model = type === "PRODUCT" ? CatalogProduct : MenuItem;
    const items = await model
      .find({ _id: { $in: selected }, businessId })
      .select("categoryId")
      .lean();
    found += items.length;
    ids.push(...items.map((item) => String(item.categoryId)));
  }
  response.json({ categoryIds: [...new Set(ids)], missingReferences: refs.length - found });
});
landingManagementRouter.get("/pages", async (request, response) => {
  const items = await LandingPage.find({
    businessId: getOwner(request).businessId,
    isArchived: { $ne: true },
  })
    .sort({ createdAt: 1 })
    .lean();
  const variants = await LandingPageVariant.find({
    businessId: getOwner(request).businessId,
    _id: { $in: items.map((page) => page.publishedVariantId).filter(Boolean) },
  })
    .select("revision")
    .lean();
  response.json({
    items: items.map((page) => ({
      ...page,
      hasUnpublishedChanges:
        page.isPublished &&
        page.publishedSourceVariantRevision !==
          (variants.find((variant) => String(variant._id) === String(page.publishedVariantId))
            ?.revision ?? 1),
    })),
    capabilities: {
      multiplePages: true,
      categoryBinding: true,
      schedules: true,
      savedTemplates: true,
    },
  });
});
landingManagementRouter.post("/pages", async (request, response) =>
  response.status(201).json(await createPage(request)),
);
landingManagementRouter.get("/subdomains/availability", async (request, response) => {
  const raw = String(request.query.slug ?? "")
    .trim()
    .toLowerCase();
  if (slugReserved(raw)) return response.json({ slug: raw, status: "RESERVED" });
  const slug = parseSlug(raw);
  let pageId: string | undefined;
  if (request.query.pageId) {
    if (!mongoose.isValidObjectId(request.query.pageId))
      throw new HttpError(422, "Invalid page id");
    const owned = await LandingPage.findOne({
      _id: request.query.pageId,
      businessId: getOwner(request).businessId,
    }).lean();
    if (!owned) throw new HttpError(404, "Page was not found");
    pageId = String(owned._id);
  }
  const existing = await LandingPage.findOne({ slug }).select("_id").lean();
  response.set("Cache-Control", "no-store");
  response.json({
    slug,
    status: !existing ? "AVAILABLE" : String(existing._id) === pageId ? "CURRENT_PAGE" : "TAKEN",
  });
});
landingManagementRouter.delete("/pages/:pageId", async (request, response) => {
  const page = await ownedPage(request);
  const revision = v.parse(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
    request.body.expectedPageRevision,
  );
  const result = await LandingPage.updateOne(
    { _id: page._id, businessId: getOwner(request).businessId, ...revisionFilter(revision) },
    { $set: { isArchived: true, isPublished: false }, $inc: { revision: 1 } },
  );
  if (!result.modifiedCount)
    throw new HttpError(
      409,
      "Page changed; reload before deleting",
      undefined,
      "PAGE_REVISION_CONFLICT",
    );
  response.status(204).send();
});
landingManagementRouter.get("/saved-templates", async (request, response) => {
  const items = await LandingPageSavedTemplate.find({ businessId: getOwner(request).businessId })
    .select("name revision document.template document.goal createdAt updatedAt")
    .sort({ updatedAt: -1 })
    .lean();
  response.json({ items });
});
const templateSave = v.strictObject({
  sourceVariantId: v.pipe(v.string(), v.regex(/^[a-f0-9]{24}$/i)),
  expectedVariantRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  expectedTemplateRevision: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80))),
});
for (const method of ["post", "put"] as const)
  landingManagementRouter[method](
    method === "post" ? "/saved-templates" : "/saved-templates/:templateId",
    async (request, response) => {
      const owner = getOwner(request);
      const input = v.parse(templateSave, request.body);
      const destinationId = (request.params as Record<string, string>).templateId;
      if (destinationId && !mongoose.isValidObjectId(destinationId))
        throw new HttpError(422, "Invalid saved template id");
      try {
        const result = await idempotent(
          owner.businessId,
          request.get("Idempotency-Key"),
          destinationId ? `overwrite-template:${destinationId}` : "save-template",
          input,
          async () => {
            const source = await LandingPageVariant.findOne({
              _id: input.sourceVariantId,
              businessId: owner.businessId,
            }).lean();
            if (!source) throw new HttpError(404, "Source draft was not found");
            if ((source.revision ?? 1) !== input.expectedVariantRevision)
              throw new HttpError(
                409,
                "Save the latest draft before saving a template",
                undefined,
                "DRAFT_REVISION_CONFLICT",
              );
            const document = v.parse(landingPageVariantUpdateSchema, source);
            await assertImageReferences(document, owner.businessId);
            await assertLandingCatalogReferences(document, owner.businessId);
            let template: any;
            if (destinationId) {
              if (!input.expectedTemplateRevision)
                throw new HttpError(422, "Specify the current saved template revision");
              template = await LandingPageSavedTemplate.findOneAndUpdate(
                {
                  _id: destinationId,
                  businessId: owner.businessId,
                  revision: input.expectedTemplateRevision,
                },
                { $set: { document, updatedByUserId: owner.userId }, $inc: { revision: 1 } },
                { new: true },
              ).lean();
              if (!template)
                throw new HttpError(
                  409,
                  "The saved template changed. Reload its details or save as new.",
                  undefined,
                  "TEMPLATE_REVISION_CONFLICT",
                );
            } else {
              if (!input.name) throw new HttpError(422, "Name the new template");
              template = (
                await LandingPageSavedTemplate.create({
                  businessId: owner.businessId,
                  name: input.name,
                  normalizedName: input.name.normalize("NFKC").toLowerCase(),
                  document,
                  createdByUserId: owner.userId,
                  updatedByUserId: owner.userId,
                })
              ).toObject();
            }
            await LandingPageVariant.updateOne(
              {
                _id: source._id,
                businessId: owner.businessId,
                ...revisionFilter(input.expectedVariantRevision),
              },
              {
                $set: {
                  sourceSavedTemplateId: template._id,
                  sourceSavedTemplateRevision: template.revision,
                },
              },
            );
            return template;
          },
        );
        response.status(destinationId ? 200 : 201).json(result);
      } catch (error) {
        if ((error as { code?: number }).code === 11000)
          throw new HttpError(
            409,
            "A saved template already has this name. Choose it explicitly to overwrite, or use a new name.",
            undefined,
            "TEMPLATE_NAME_TAKEN",
          );
        throw error;
      }
    },
  );
