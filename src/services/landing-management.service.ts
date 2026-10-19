import { createHash } from "node:crypto";
import type { Request } from "express";
import mongoose, { type Types } from "mongoose";
import * as v from "valibot";
import { assertImageReferences } from "../images/references.js";
import { HttpError } from "../lib/http-error.js";
import { inTransaction } from "../lib/transaction.js";
import { getOwner } from "../middleware/auth.js";
import {
  Business,
  LandingOperation,
  LandingPage,
  LandingPageSavedTemplate,
  LandingPageVariant,
} from "../models/index.js";
import {
  landingPageSettingsSchema,
  landingPageVariantUpdateSchema,
  templateIds,
} from "../validation/landing-page.js";
import { getBuilderCatalogItems } from "./commerce.service.js";
import { createLandingPreset } from "./landing-presets.js";
import { assertLandingCatalogReferences } from "./landing-references.js";

export const slugSchema = landingPageSettingsSchema.entries.slug;
export const slugReserved = (slug: string) =>
  [
    "api",
    "app",
    "www",
    ...(process.env.RESERVED_PUBLIC_SITE_SLUGS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ].includes(slug);
export function parseSlug(value: unknown) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase();
  if (slugReserved(slug))
    throw new HttpError(422, "This subdomain is reserved", undefined, "SUBDOMAIN_RESERVED");
  return v.parse(slugSchema, slug);
}
export function revisionFilter(revision: number) {
  return revision === 1
    ? { $or: [{ revision: 1 }, { revision: { $exists: false } }] }
    : { revision };
}
export async function ownedPage(request: Request) {
  const { businessId } = getOwner(request);
  const pageId = request.params.pageId;
  if (pageId && !mongoose.isValidObjectId(pageId)) throw new HttpError(400, "Invalid page id");
  let page = await LandingPage.findOne({
    businessId,
    ...(pageId ? { _id: pageId } : { isLegacyDefault: true }),
    isArchived: { $ne: true },
  });
  if (!page && !pageId) {
    // Before the migration, a single page is unambiguous. Persist its explicit mapping.
    const pages = await LandingPage.find({ businessId, isArchived: { $ne: true } }).limit(2);
    if (pages.length === 1 && !pages[0]?.isArchived) {
      page = pages[0]!;
      await LandingPage.updateOne({ _id: page._id }, { $set: { isLegacyDefault: true } });
    } else if (pages.length > 1)
      throw new HttpError(
        409,
        "Open a specific landing page in the updated editor",
        undefined,
        "UPGRADE_REQUIRED",
      );
  }
  if (!page) throw new HttpError(404, "Landing page was not found");
  return page;
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export async function idempotent<T>(
  businessId: Types.ObjectId,
  key: unknown,
  kind: string,
  input: unknown,
  work: () => Promise<T>,
): Promise<T> {
  const operationKey = v.parse(
    v.pipe(v.string(), v.minLength(16), v.maxLength(100), v.regex(/^[a-z0-9_-]+$/i)),
    key,
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
  const lookup = async () => {
    const previous = await LandingOperation.findOne({ businessId, key: operationKey }).lean();
    if (previous && (previous.kind !== kind || previous.fingerprint !== fingerprint))
      throw new HttpError(
        409,
        "This operation key was used for different changes",
        undefined,
        "IDEMPOTENCY_CONFLICT",
      );
    return previous;
  };
  try {
    return await inTransaction(async () => {
      const previous = await lookup();
      if (previous) return previous.result as T;
      const result = await work();
      await LandingOperation.create({
        businessId,
        key: operationKey,
        kind,
        fingerprint,
        result: JSON.parse(JSON.stringify(result)),
      });
      return result;
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const previous = await lookup();
      if (previous) return previous.result as T;
    }
    throw error;
  }
}
export const newPageSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  slug: v.string(),
  templateId: v.optional(v.picklist(templateIds)),
  sourceVariantId: v.optional(v.string()),
  expectedVariantRevision: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  savedTemplateId: v.optional(v.string()),
});
export async function createPage(request: Request) {
  const owner = getOwner(request);
  const input = v.parse(newPageSchema, request.body);
  const slug = parseSlug(input.slug);
  if ([input.templateId, input.sourceVariantId, input.savedTemplateId].filter(Boolean).length > 1)
    throw new HttpError(422, "Choose one starting design");
  try {
    return await idempotent(
      owner.businessId,
      request.get("Idempotency-Key"),
      "create-page",
      { ...input, slug },
      async () => {
        const business = await Business.findById(owner.businessId).lean();
        if (!business) throw new HttpError(404, "Business was not found");
        let design: any;
        let sourceTemplate: any;
        if (input.sourceVariantId) {
          if (!mongoose.isValidObjectId(input.sourceVariantId))
            throw new HttpError(422, "Select an owned draft");
          const source = await LandingPageVariant.findOne({
            _id: input.sourceVariantId,
            businessId: owner.businessId,
          }).lean();
          if (!source) throw new HttpError(404, "Source draft was not found");
          if (input.expectedVariantRevision !== (source.revision ?? 1))
            throw new HttpError(
              409,
              "Save or reload the source draft before cloning",
              undefined,
              "DRAFT_REVISION_CONFLICT",
            );
          design = source;
        } else if (input.savedTemplateId) {
          if (!mongoose.isValidObjectId(input.savedTemplateId))
            throw new HttpError(422, "Select an owned template");
          sourceTemplate = await LandingPageSavedTemplate.findOne({
            _id: input.savedTemplateId,
            businessId: owner.businessId,
          }).lean();
          if (!sourceTemplate) throw new HttpError(404, "Saved template was not found");
          design = sourceTemplate.document;
        } else {
          if (process.env.LANDING_V2_TEMPLATES === "false")
            throw new HttpError(409, "New templates are temporarily unavailable");
          design = createLandingPreset(
            input.templateId ?? "farm-and-market",
            undefined,
            undefined,
            business,
            await getBuilderCatalogItems(owner.businessId),
          );
          for (const section of design.sections)
            for (const block of section.components)
              if (block.type === "CATALOG" || block.type === "MENU") {
                block.content.categoryBinding = { mode: "ALL_CATEGORIES" };
                if (block.type === "CATALOG") block.content.catalogItemRefs = [];
                else block.content.menuItemIds = [];
              }
          design.categoryBindingVersion = 1;
        }
        const document = v.parse(landingPageVariantUpdateSchema, { ...design, name: "Main" });
        await assertImageReferences(document, owner.businessId);
        await assertLandingCatalogReferences(document, owner.businessId);
        const page = await LandingPage.create({
          businessId: owner.businessId,
          name: input.name,
          slug,
          siteTitle: input.name,
        });
        const variant = await LandingPageVariant.create({
          ...document,
          businessId: owner.businessId,
          landingPageId: page._id,
          createdByUserId: owner.userId,
          updatedByUserId: owner.userId,
          sourceSavedTemplateId: sourceTemplate?._id ?? design.sourceSavedTemplateId,
          sourceSavedTemplateRevision:
            sourceTemplate?.revision ?? design.sourceSavedTemplateRevision,
        });
        return { page: page.toObject(), variant: variant.toObject() };
      },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      throw new HttpError(409, "This subdomain is already taken", undefined, "SUBDOMAIN_TAKEN");
    throw error;
  }
}
