import { Schema } from "mongoose";
import { createModel, objectId, schemaOptions } from "./helpers.js";

const eventSchema = new Schema(
  {
    businessId: objectId("Business", true),
    landingPageId: objectId("LandingPage", true),
    eventId: { type: String, required: true },
    type: { type: String, enum: ["page_view", "cta_click", "checkout_started"], required: true },
    sessionId: { type: String, required: true },
    visitorId: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },
    componentId: String,
    referrerHost: String,
    deviceCategory: String,
    publicationId: String,
    expiresAt: { type: Date, default: () => new Date(Date.now() + 90 * 86400000) },
  },
  schemaOptions,
);
eventSchema.index({ businessId: 1, landingPageId: 1, eventId: 1 }, { unique: true });
eventSchema.index({ businessId: 1, landingPageId: 1, occurredAt: 1 });
eventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const sessionSchema = new Schema(
  {
    businessId: objectId("Business", true),
    landingPageId: objectId("LandingPage", true),
    sessionId: { type: String, required: true },
    visitorId: { type: String, required: true },
    startedAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    convertedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 90 * 86400000) },
  },
  schemaOptions,
);
sessionSchema.index({ businessId: 1, landingPageId: 1, sessionId: 1 }, { unique: true });
sessionSchema.index({ businessId: 1, landingPageId: 1, startedAt: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const dailySchema = new Schema(
  {
    businessId: objectId("Business", true),
    landingPageId: objectId("LandingPage", true),
    day: { type: String, required: true },
    views: Number,
    visits: Number,
    visitors: Number,
    expiresAt: { type: Date, required: true },
  },
  schemaOptions,
);
dailySchema.index({ businessId: 1, landingPageId: 1, day: 1 }, { unique: true });
dailySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const LandingEvent = createModel("LandingEvent", eventSchema);
export const LandingVisit = createModel("LandingVisit", sessionSchema);
export const LandingDailyTotal = createModel("LandingDailyTotal", dailySchema);
