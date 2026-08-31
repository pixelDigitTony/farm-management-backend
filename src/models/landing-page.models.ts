import mongoose from "mongoose";
import { createModel, objectId, schemaOptions } from "./helpers.js";

const { Schema } = mongoose;

const landingPageSchema = new Schema(
  {
    businessId: objectId("Business", true),
    slug: { type: String, required: true, trim: true, lowercase: true },
    siteTitle: { type: String, required: true, trim: true },
    seoDescription: { type: String, default: "", trim: true },
    isPublished: { type: Boolean, default: false },
    publishedVariantId: objectId("LandingPageVariant"),
    publishedSnapshot: { type: Schema.Types.Mixed, default: null },
    publishedAt: { type: Date, default: null },
    publishedByUserId: objectId("User"),
  },
  schemaOptions,
);
landingPageSchema.index({ businessId: 1 }, { unique: true });
landingPageSchema.index({ slug: 1 }, { unique: true });

const landingPageVariantSchema = new Schema(
  {
    businessId: objectId("Business", true),
    landingPageId: objectId("LandingPage", true),
    name: { type: String, required: true, trim: true },
    theme: { type: Schema.Types.Mixed, required: true },
    sections: { type: [Schema.Types.Mixed], default: [] },
    // Kept temporarily so existing variants can be migrated into a default section on their next save.
    components: { type: [Schema.Types.Mixed], default: [] },
    createdByUserId: objectId("User", true),
    updatedByUserId: objectId("User", true),
  },
  schemaOptions,
);
landingPageVariantSchema.index({ businessId: 1, landingPageId: 1, createdAt: 1 });
landingPageVariantSchema.index({ landingPageId: 1, name: 1 }, { unique: true });

export const LandingPage = createModel("LandingPage", landingPageSchema);
export const LandingPageVariant = createModel("LandingPageVariant", landingPageVariantSchema);
