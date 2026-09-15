import type { Types } from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { StoredImage } from "../models/image.models.js";
export const imageReference = /^\/api\/images\/([a-f0-9]{24})$/;
export function imageIds(value: unknown): string[] {
  if (typeof value === "string") {
    const match = imageReference.exec(value);
    if (value.startsWith("/api/images/") && !match)
      throw new HttpError(422, "Invalid stored image reference");
    return match?.[1] ? [match[1]] : [];
  }
  if (Array.isArray(value)) return value.flatMap(imageIds);
  if (value && typeof value === "object") return Object.values(value).flatMap(imageIds);
  return [];
}
export async function assertImageReferences(value: unknown, businessId: Types.ObjectId) {
  const ids = [...new Set(imageIds(value))];
  if (
    ids.length &&
    (await StoredImage.countDocuments({ _id: { $in: ids }, businessId })) !== ids.length
  )
    throw new HttpError(422, "An image is not ready or does not belong to this business");
}
