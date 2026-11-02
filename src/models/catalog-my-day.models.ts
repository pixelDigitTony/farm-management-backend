import mongoose from "mongoose";
import { createModel, objectId, schemaOptions } from "./helpers.js";

const schema = new mongoose.Schema(
  {
    businessId: objectId("Business", true),
    landingPageId: objectId("LandingPage", true),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    heading: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: "", maxlength: 240 },
    productIds: { type: [mongoose.Schema.Types.ObjectId], ref: "CatalogProduct", required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    timezone: { type: String, required: true },
    isEnabled: { type: Boolean, default: false },
    revision: { type: Number, default: 1 },
    createdByUserId: objectId("User", true),
    updatedByUserId: objectId("User", true),
  },
  schemaOptions,
);
schema.index({ businessId: 1, landingPageId: 1, isEnabled: 1, startsAt: 1, endsAt: 1 });
schema.index({ businessId: 1, createdAt: -1, _id: 1 });
export const CatalogMyDayCampaign = createModel("CatalogMyDayCampaign", schema);
