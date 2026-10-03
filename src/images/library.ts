import { HttpError } from "../lib/http-error.js";

export const trashedImageMessage =
  "This image is in Trash. Ask someone with Media library remove permission to restore it before uploading again.";

export function assertActiveImage(image: { trashedAt?: unknown } | null | undefined) {
  if (image?.trashedAt) throw new HttpError(409, trashedImageMessage);
}
