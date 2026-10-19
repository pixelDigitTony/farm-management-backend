import mongoose from "mongoose";
import { createModel, objectId, schemaOptions } from "./helpers.js";

const schema = new mongoose.Schema(
  {
    businessId: objectId("Business", true),
    sourceType: { type: String, enum: ["PRODUCT", "MENU_ITEM"], required: true },
    name: { type: String, required: true },
    normalizedName: { type: String, required: true },
    isUncategorized: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false },
  },
  schemaOptions,
);
schema.index({ businessId: 1, sourceType: 1, normalizedName: 1 }, { unique: true });
export const CatalogCategory = createModel("CatalogCategory", schema);
