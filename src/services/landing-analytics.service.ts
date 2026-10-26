import mongoose from "mongoose";
import * as v from "valibot";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";
import {
  Business,
  CustomerOrder,
  LandingDailyTotal,
  LandingEvent,
  LandingPage,
  LandingVisit,
} from "../models/index.js";

const statisticsCache = new Map<string, { expiresAt: number; value: unknown }>();
const identifier = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{16,100}$/));
const eventSchema = v.object({
  eventId: identifier,
  visitorId: identifier,
  sessionId: identifier,
  type: v.picklist(["page_view", "cta_click", "checkout_started"]),
  occurredAt: v.pipe(v.string(), v.isoTimestamp()),
  componentId: v.optional(v.pipe(v.string(), v.maxLength(100))),
  referrerHost: v.optional(v.pipe(v.string(), v.maxLength(253), v.regex(/^[a-zA-Z0-9.-]*$/))),
  deviceCategory: v.optional(v.picklist(["mobile", "tablet", "desktop", "unknown"]), "unknown"),
});
const batchSchema = v.object({
  events: v.pipe(v.array(eventSchema), v.minLength(1), v.maxLength(20)),
});
export async function recordLandingEvents(slug: string, body: unknown, userAgent = "") {
  if (env.LANDING_ANALYTICS_ENABLED !== "true") return;
  if (Buffer.byteLength(JSON.stringify(body)) > 16384)
    throw new HttpError(413, "Event batch is too large");
  const batch = v.parse(batchSchema, body);
  const page = await LandingPage.findOne({
    slug: slug.toLowerCase(),
    isPublished: true,
    isArchived: { $ne: true },
    publishedSnapshot: { $ne: null },
  }).lean();
  if (!page || !(await Business.exists({ _id: page.businessId, isArchived: { $ne: true } })))
    throw new HttpError(404, "Published page was not found");
  if (/bot|crawler|spider|headless|preview|slurp/i.test(userAgent)) return;
  const ids = new Set<string>(
    (
      page.publishedSnapshot.sections ?? [{ components: page.publishedSnapshot.components ?? [] }]
    ).flatMap((section: any) =>
      section.enabled === false
        ? []
        : section.components
            .filter((block: any) => block.enabled !== false)
            .map((block: any) => String(block.id)),
    ),
  );
  const now = new Date();
  await LandingPage.updateOne(
    { _id: page._id, analyticsStartsAt: null },
    { $set: { analyticsStartsAt: now } },
  );
  for (const event of batch.events) {
    const occurredAt = new Date(event.occurredAt);
    if (
      occurredAt.getTime() > now.getTime() + 300000 ||
      occurredAt.getTime() < now.getTime() - 86400000
    )
      throw new HttpError(422, "Event timestamp is outside the collection window");
    if (event.type === "cta_click" && (!event.componentId || !ids.has(event.componentId)))
      throw new HttpError(422, "Choose a published component");
  }
  for (const event of batch.events) {
    const scope = { businessId: page.businessId, landingPageId: page._id };
    try {
      await LandingEvent.updateOne(
        { ...scope, eventId: event.eventId },
        {
          $setOnInsert: {
            ...scope,
            ...event,
            occurredAt: new Date(event.occurredAt),
            receivedAt: now,
            publicationId: page.publishedAt?.toISOString(),
          },
        },
        { upsert: true },
      );
    } catch (error: any) {
      if (error.code !== 11000) throw error;
    }
    // Repeating session updates repairs a receipt interrupted after the event write.
    if (event.type === "page_view") {
      try {
        await LandingVisit.updateOne(
          { ...scope, sessionId: event.sessionId },
          {
            $setOnInsert: { ...scope, sessionId: event.sessionId, visitorId: event.visitorId },
            $min: { startedAt: new Date(event.occurredAt) },
            $max: { lastSeenAt: new Date(event.occurredAt) },
          },
          { upsert: true },
        );
      } catch (error: any) {
        if (error.code !== 11000) throw error;
      }
    } else {
      await LandingVisit.updateOne(
        { ...scope, sessionId: event.sessionId },
        { $max: { lastSeenAt: new Date(event.occurredAt) } },
      );
    }
  }
}

export function parseStatisticsRange(query: Record<string, unknown>) {
  const timezone = typeof query.timezone === "string" ? query.timezone : "Asia/Manila";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new HttpError(422, "Choose a valid timezone");
  }
  const from = new Date(String(query.from));
  const to = new Date(String(query.to));
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    to <= from ||
    to.getTime() - from.getTime() > 90 * 86400000 ||
    from.getTime() < Date.now() - 91 * 86400000
  )
    throw new HttpError(422, "Choose a date range of up to 90 days within retained history");
  return { from, to, timezone };
}
export async function landingStatistics(
  businessId: unknown,
  pageId: string,
  query: Record<string, unknown>,
) {
  if (!mongoose.isValidObjectId(pageId)) throw new HttpError(404, "Page was not found");
  const page = await LandingPage.findOne({ _id: pageId, businessId }).lean();
  if (!page) throw new HttpError(404, "Page was not found");
  const { from, to, timezone } = parseStatisticsRange(query);
  const cacheKey = `${page.businessId}:${pageId}:${from.toISOString()}:${to.toISOString()}:${timezone}:${env.LANDING_ANALYTICS_ENABLED}`;
  const cached = statisticsCache.get(cacheKey);
  if (env.NODE_ENV !== "test" && cached && cached.expiresAt > Date.now()) return cached.value;
  const started = performance.now();
  const scope = { businessId: page.businessId, landingPageId: page._id };
  const interval = { $gte: from, $lt: to };
  const [
    summary,
    daily,
    referrers,
    devices,
    ordersCreated,
    cohortVisits,
    converted,
    first,
    intervalSessions,
  ] = await Promise.all([
    LandingEvent.aggregate([
      { $match: { ...scope, occurredAt: interval } },
      {
        $group: {
          _id: null,
          pageViews: { $sum: { $cond: [{ $eq: ["$type", "page_view"] }, 1, 0] } },
          ctaClicks: { $sum: { $cond: [{ $eq: ["$type", "cta_click"] }, 1, 0] } },
          checkoutSessions: {
            $addToSet: {
              $cond: [{ $eq: ["$type", "checkout_started"] }, "$sessionId", "$$REMOVE"],
            },
          },
          visitors: {
            $addToSet: { $cond: [{ $eq: ["$type", "page_view"] }, "$visitorId", "$$REMOVE"] },
          },
        },
      },
      {
        $project: {
          _id: 0,
          pageViews: 1,
          ctaClicks: 1,
          checkoutStarts: { $size: "$checkoutSessions" },
          uniqueVisitors: { $size: "$visitors" },
        },
      },
    ]),
    LandingEvent.aggregate([
      { $match: { ...scope, occurredAt: interval, type: "page_view" } },
      {
        $group: {
          _id: { $dateToString: { date: "$occurredAt", format: "%Y-%m-%d", timezone } },
          views: { $sum: 1 },
          visitors: { $addToSet: "$visitorId" },
        },
      },
      { $project: { _id: 0, date: "$_id", views: 1, visitors: { $size: "$visitors" } } },
      { $sort: { date: 1 } },
    ]),
    LandingEvent.aggregate([
      { $match: { ...scope, occurredAt: interval, type: "page_view" } },
      { $group: { _id: { $ifNull: ["$referrerHost", "direct/unknown"] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    LandingEvent.aggregate([
      { $match: { ...scope, occurredAt: interval, type: "page_view" } },
      { $group: { _id: "$deviceCategory", count: { $sum: 1 } } },
    ]),
    CustomerOrder.countDocuments({ ...scope, createdAt: interval }),
    LandingVisit.countDocuments({ ...scope, startedAt: interval }),
    CustomerOrder.distinct("analyticsSessionId", {
      ...scope,
      analyticsSessionId: { $ne: null },
      createdAt: { $lt: to },
      // Session start is checked below rather than trusting client conversion events.
    }),
    LandingEvent.findOne(scope).sort({ receivedAt: 1 }).select("receivedAt").lean(),
    LandingEvent.distinct("sessionId", { ...scope, type: "page_view", occurredAt: interval }),
  ]);
  const convertedVisits = await LandingVisit.countDocuments({
    ...scope,
    startedAt: interval,
    sessionId: { $in: converted },
  });
  const dayKey = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  const dailyRows = new Map<string, any>(daily.map((row) => [row.date, row]));
  const series = [];
  const lastDay = dayKey(new Date(to.getTime() - 1));
  for (
    let day = dayKey(from);
    day <= lastDay;
    day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
  ) {
    series.push(dailyRows.get(day) ?? { date: day, views: 0, visitors: 0 });
  }
  const result = {
    enabled: env.LANDING_ANALYTICS_ENABLED === "true",
    pageId,
    timezone,
    from,
    to,
    generatedAt: new Date(),
    trackingStartsAt: page.analyticsStartsAt ?? first?.receivedAt ?? null,
    summary: {
      pageViews: 0,
      uniqueVisitors: 0,
      checkoutStarts: 0,
      ctaClicks: 0,
      ...summary[0],
      visits: intervalSessions.length,
      cohortVisits,
      ordersCreated,
      convertedVisits,
      conversionRate: cohortVisits ? (convertedVisits / cohortVisits) * 100 : null,
    },
    daily: series,
    referrers,
    devices,
  };
  if (statisticsCache.size >= 100)
    statisticsCache.delete(statisticsCache.keys().next().value ?? "");
  statisticsCache.set(cacheKey, { expiresAt: Date.now() + 15000, value: result });
  console.info(
    JSON.stringify({
      event: "landing_statistics",
      pageId,
      durationMs: Math.round(performance.now() - started),
    }),
  );
  return result;
}

export async function retainDailyAnalytics() {
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0);
  const from = new Date(to.getTime() - 86400000);
  const rows = await LandingEvent.aggregate([
    { $match: { type: "page_view", occurredAt: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: { businessId: "$businessId", landingPageId: "$landingPageId" },
        views: { $sum: 1 },
        visitors: { $addToSet: "$visitorId" },
        visits: { $addToSet: "$sessionId" },
      },
    },
  ]);
  for (const row of rows)
    await LandingDailyTotal.updateOne(
      { ...row._id, day: from.toISOString().slice(0, 10) },
      {
        $set: {
          views: row.views,
          visitors: row.visitors.length,
          visits: row.visits.length,
          expiresAt: new Date(Date.now() + 396 * 86400000),
        },
      },
      { upsert: true },
    );
}
