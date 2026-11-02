import type { Types } from "mongoose";
import { myDayProductKeys, myDayStatus, resolveMyDay } from "../lib/catalog-my-day.js";
import { HttpError } from "../lib/http-error.js";
import { effectiveActive } from "../lib/product-availability.js";
import {
  AuditLog,
  Business,
  CatalogMyDayCampaign,
  CatalogProduct,
  LandingPage,
} from "../models/index.js";
import type { MyDayInput } from "../validation/catalog-my-day.js";
import { getPublishedCatalogItems } from "./commerce.service.js";

export async function assertMyDayReferences(
  businessId: Types.ObjectId,
  input: Pick<MyDayInput, "landingPageId" | "productIds">,
) {
  const page = await LandingPage.findOne({
    _id: input.landingPageId,
    businessId,
    isArchived: { $ne: true },
  }).lean();
  if (!page) throw new HttpError(422, "Choose a landing page belonging to this business");
  if (
    (await CatalogProduct.countDocuments({ _id: { $in: input.productIds }, businessId })) !==
    input.productIds.length
  )
    throw new HttpError(422, "A selected product is missing or belongs to another business");
  return page;
}
export function myDayDates(input: MyDayInput, now: Date, requireFuture: boolean) {
  const startsAt = input.startNow ? now : new Date(input.startsAt ?? "");
  const endsAt = new Date(input.endsAt);
  if (endsAt <= startsAt) throw new HttpError(422, "End must be after start");
  if (requireFuture && endsAt <= now) throw new HttpError(422, "Choose an end time in the future");
  return { startsAt, endsAt };
}
export async function previewMyDay(businessId: Types.ObjectId, input: MyDayInput, at?: Date) {
  const page = await assertMyDayReferences(businessId, input);
  const dates = myDayDates(input, new Date(), false);
  const now = at ?? new Date(Math.max(Date.now(), +dates.startsAt));
  if (!page.isPublished || !page.publishedSnapshot)
    return {
      myDay: null,
      catalogItems: [],
      theme: null,
      excluded: input.productIds.map((productId) => ({ productId, reason: "Page unpublished" })),
      at: now.toISOString(),
    };
  const snapshot = page.publishedSnapshot as { goal?: string; theme?: unknown };
  const items = await getPublishedCatalogItems(businessId, snapshot, now);
  const campaign = { ...input, ...dates, _id: "preview", isEnabled: true };
  const keys = myDayProductKeys(campaign, items, snapshot.goal);
  const outside = now < dates.startsAt || now >= dates.endsAt;
  const products = await CatalogProduct.find({ businessId, _id: { $in: input.productIds } })
    .select("isActive availabilitySchedule")
    .lean();
  return {
    myDay: resolveMyDay([campaign], items, snapshot.goal, now),
    catalogItems: items.filter((item) => keys.includes(item.key)),
    theme: snapshot.theme,
    excluded: input.productIds
      .filter((id) => outside || !keys.includes(`PRODUCT:${id}`))
      .map((productId) => ({
        productId,
        reason: (() => {
          const product = products.find((item) => String(item._id) === productId);
          if (outside) return "Outside the scheduled window";
          if (!product?.isActive) return "Product inactive or archived";
          if (!effectiveActive(product, now)) return "Outside the product availability schedule";
          if (!items.some((item) => item.sourceType === "PRODUCT" && item.sourceId === productId))
            return "Not included in the published catalog";
          return "Not orderable or out of stock for this shopping page";
        })(),
      })),
    at: now.toISOString(),
  };
}
export async function myDayList(
  businessId: Types.ObjectId,
  now: Date,
  pageId?: string,
  status?: string,
  offset = 0,
  limit = 20,
) {
  const query: Record<string, unknown> = {
    businessId,
    ...(pageId ? { landingPageId: pageId } : {}),
  };
  if (status === "Disabled") query.isEnabled = false;
  if (status === "Scheduled") Object.assign(query, { isEnabled: true, startsAt: { $gt: now } });
  if (status === "Active")
    Object.assign(query, { isEnabled: true, startsAt: { $lte: now }, endsAt: { $gt: now } });
  if (status === "Ended") Object.assign(query, { isEnabled: true, endsAt: { $lte: now } });
  const [campaigns, total, pages, business] = await Promise.all([
    CatalogMyDayCampaign.find(query)
      .sort({ createdAt: -1, _id: 1 })
      .skip(offset)
      .limit(limit)
      .lean(),
    CatalogMyDayCampaign.countDocuments(query),
    LandingPage.find({ businessId, isArchived: { $ne: true } })
      .select("name slug isPublished publishedSnapshot")
      .lean(),
    Business.findById(businessId).select("timezone").lean(),
  ]);
  const contexts = new Map<
    string,
    { items: Awaited<ReturnType<typeof getPublishedCatalogItems>>; winner: string | undefined }
  >();
  for (const page of pages.filter(
    (p) =>
      p.isPublished &&
      p.publishedSnapshot &&
      campaigns.some((c) => String(c.landingPageId) === String(p._id)),
  )) {
    const snapshot = page.publishedSnapshot as { goal?: string };
    const items = await getPublishedCatalogItems(businessId, snapshot, now);
    const active = await CatalogMyDayCampaign.find({
      businessId,
      landingPageId: page._id,
      isEnabled: true,
      startsAt: { $lte: now },
      endsAt: { $gt: now },
    }).lean();
    contexts.set(String(page._id), {
      items,
      winner: resolveMyDay(active, items, snapshot.goal, now)?.id,
    });
  }
  return {
    items: campaigns.map((c) => {
      const page = pages.find((p) => String(p._id) === String(c.landingPageId));
      const ctx = contexts.get(String(c.landingPageId));
      const state = myDayStatus(c, now);
      const diagnostics: string[] = [];
      if (!ctx) diagnostics.push("Page unpublished");
      else if (
        !myDayProductKeys(c, ctx.items, (page?.publishedSnapshot as { goal?: string })?.goal).length
      )
        diagnostics.push("No eligible products");
      else if (state === "Active" && ctx.winner !== String(c._id))
        diagnostics.push("Superseded by another active campaign");
      return { ...c, status: state, diagnostics, pageName: page?.name ?? "Unavailable page" };
    }),
    total,
    pages: pages.map(({ publishedSnapshot: _snapshot, ...page }) => page),
    timezone: business?.timezone ?? "Asia/Manila",
    serverTime: now.toISOString(),
  };
}
export async function auditMyDay(
  businessId: Types.ObjectId,
  userId: Types.ObjectId,
  before: unknown,
  after: unknown,
  id: Types.ObjectId,
  action: "CREATE" | "UPDATE" | "DELETE",
) {
  await AuditLog.create({
    businessId,
    userId,
    action,
    targetCollection: "catalog-my-day-campaigns",
    targetDocumentId: id,
    changedFields: ["campaign"],
    before,
    after,
  });
}
