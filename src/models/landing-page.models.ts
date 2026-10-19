import mongoose from "mongoose";
import { createModel, objectId, schemaOptions } from "./helpers.js";

const { Schema } = mongoose;

const landingPageSchema = new Schema(
  {
    businessId: objectId("Business", true),
    name: { type: String, default: "Landing page" },
    revision: { type: Number, default: 1 },
    isLegacyDefault: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false },
    creationKey: { type: String },
    creationFingerprint: { type: String },
    publishedSourceVariantRevision: { type: Number },
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
landingPageSchema.index({ businessId: 1, createdAt: -1 });
landingPageSchema.index(
  { businessId: 1, creationKey: 1 },
  { unique: true, partialFilterExpression: { creationKey: { $type: "string" } } },
);
landingPageSchema.index({ slug: 1 }, { unique: true });

const landingPageVariantSchema = new Schema(
  {
    businessId: objectId("Business", true),
    landingPageId: objectId("LandingPage", true),
    name: { type: String, required: true, trim: true },
    revision: { type: Number, default: 1 },
    sourceSavedTemplateId: objectId("LandingPageSavedTemplate"),
    sourceSavedTemplateRevision: { type: Number },
    categoryBindingVersion: { type: Number },
    schemaVersion: { type: Number, enum: [1, 2], default: 1 },
    template: { type: Schema.Types.Mixed },
    goal: { type: String, enum: ["SHOP", "CATALOG", "INQUIRY"] },
    theme: { type: Schema.Types.Mixed, required: true },
    commerce: { type: Schema.Types.Mixed, required: true, default: {} },
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

const savedTemplateSchema = new Schema(
  {
    businessId: objectId("Business", true),
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true },
    revision: { type: Number, default: 1 },
    document: { type: Schema.Types.Mixed, required: true },
    creationKey: { type: String },
    creationFingerprint: { type: String },
    lastOperationKey: { type: String },
    createdByUserId: objectId("User", true),
    updatedByUserId: objectId("User", true),
  },
  schemaOptions,
);
savedTemplateSchema.index({ businessId: 1, normalizedName: 1 }, { unique: true });
savedTemplateSchema.index(
  { businessId: 1, creationKey: 1 },
  { unique: true, partialFilterExpression: { creationKey: { $type: "string" } } },
);
export const LandingPageSavedTemplate = createModel(
  "LandingPageSavedTemplate",
  savedTemplateSchema,
);

const operationSchema = new Schema(
  {
    businessId: objectId("Business", true),
    key: { type: String, required: true },
    kind: { type: String, required: true },
    fingerprint: { type: String, required: true },
    result: { type: Schema.Types.Mixed, required: true },
  },
  schemaOptions,
);
operationSchema.index({ businessId: 1, key: 1 }, { unique: true });
export const LandingOperation = createModel("LandingOperation", operationSchema);
