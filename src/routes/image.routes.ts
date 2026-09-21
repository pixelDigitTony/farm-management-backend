import { type Request, type Response, Router } from "express";
import mongoose from "mongoose";
import { type ImageProfile, imageConfig } from "../images/config.js";
import { stageUpload } from "../images/queue.js";
import { imageIds } from "../images/references.js";
import { imageProcessingStatus } from "../images/service.js";
import { HttpError } from "../lib/http-error.js";
import { effectivePermissions } from "../lib/permissions.js";
import { getOwner, requireApproved, requireOwner } from "../middleware/auth.js";
import { ImageJob, ImageLock, StoredImage } from "../models/image.models.js";
import { Business, LandingPage } from "../models/index.js";
import { getPublishedCatalogItems } from "../services/commerce.service.js";
export const imageRouter = Router();
export const publicImageRouter = Router();
async function allowed(request: Request, scope: string, write: boolean) {
  const owner = getOwner(request);
  if (!["catalog", "menu", "landing-page"].includes(scope))
    throw new HttpError(422, "Choose an image usage");
  const business = await Business.findById(owner.businessId).select("roles ownerRole").lean();
  const highest = owner.role === 99 || owner.role === Number(business?.ownerRole);
  const permissions = effectivePermissions(
    business?.roles.find((r: any) => r.level === owner.role),
    highest,
  );
  if (
    !permissions.includes(`${scope}:view`) ||
    (write && !["create", "edit"].some((action) => permissions.includes(`${scope}:${action}`)))
  )
    throw new HttpError(403, "Your role cannot upload or view images for this feature");
  return owner;
}
async function deliver(request: Request, response: Response, businessId?: unknown) {
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(404, "Image not found");
  const image = await StoredImage.findOne({
    _id: request.params.id,
    ...(businessId ? { businessId } : {}),
  })
    .select("+bytes")
    .lean();
  if (!image) throw new HttpError(404, "Image not found");
  response.set({
    "Content-Type": image.mime,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-cache",
    ETag: `"${image.sha256}"`,
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (request.headers["if-none-match"] === `"${image.sha256}"`) return response.status(304).end();
  response.send(Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes.buffer));
}
publicImageRouter.get("/images/:id", async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(404, "Image not found");
  const image = await StoredImage.findById(request.params.id).lean();
  if (!image) throw new HttpError(404, "Image not found");
  const [page, business] = await Promise.all([
    LandingPage.findOne({ businessId: image.businessId, isPublished: true }).lean(),
    Business.exists({ _id: image.businessId, isArchived: { $ne: true } }),
  ]);
  if (!page?.publishedSnapshot || !business) throw new HttpError(404, "Image not found");
  const snapshot = page.publishedSnapshot;
  const sections = snapshot.sections ?? [{ enabled: true, components: snapshot.components ?? [] }];
  const visible = sections
    .filter((s: any) => s.enabled !== false)
    .flatMap((s: any) => (s.components ?? []).filter((x: any) => x.enabled !== false));
  const ids = imageIds([visible, await getPublishedCatalogItems(image.businessId, snapshot)]);
  if (!ids.includes(String(image._id))) throw new HttpError(404, "Image not found");
  await deliver(request, response, image.businessId);
});
imageRouter.use(requireOwner, requireApproved);
imageRouter.post("/jobs", async (request, response) => {
  const scope = String(request.query.scope ?? "");
  const owner = await allowed(request, scope, true);
  if (!imageProcessingStatus().ready)
    throw new HttpError(
      503,
      "Image processing is unavailable. Ask the administrator to check backend image configuration.",
    );
  const profile = String(request.query.profile ?? "photo");
  if (!Object.hasOwn(imageConfig.dimensions, profile))
    throw new HttpError(422, "Invalid image profile");
  if (request.headers["content-type"] !== "application/octet-stream")
    throw new HttpError(415, "Send the original file as application/octet-stream");
  const job = await stageUpload(
    request,
    owner.businessId,
    owner.userId,
    scope,
    profile as ImageProfile,
  );
  response.status(202).json({ jobId: String(job._id), state: job.state });
});
imageRouter.get("/jobs/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(404, "Image job not found");
  const job = await ImageJob.findOne({
    _id: request.params.id,
    businessId: owner.businessId,
    userId: owner.userId,
  }).lean();
  if (!job) throw new HttpError(404, "Image job not found");
  await allowed(request, job.scope, false);
  response.set("Cache-Control", "no-store").json({
    jobId: String(job._id),
    state: job.state,
    error: job.state === "failed" ? job.error : undefined,
    imageId: job.state === "ready" ? String(job.imageId) : undefined,
    imageUrl: job.state === "ready" ? `/api/images/${job.imageId}` : undefined,
  });
});
imageRouter.delete("/jobs/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(404, "Image job not found");
  const job = await ImageJob.findOne({
    _id: request.params.id,
    businessId: owner.businessId,
    userId: owner.userId,
  });
  if (!job) throw new HttpError(404, "Image job not found");
  await allowed(request, job.scope, true);
  await ImageJob.updateOne(
    { _id: job._id, state: { $in: ["queued", "processing"] } },
    { $set: { state: "failed", error: "Upload cancelled" } },
  );
  response.status(204).end();
});
imageRouter.get("/health", async (request, response) => {
  const owner = getOwner(request);
  const business = await Business.findById(owner.businessId).select("ownerRole").lean();
  if (owner.role !== 99 && owner.role !== Number(business?.ownerRole))
    throw new HttpError(403, "Owner access required");
  const heartbeat = await ImageLock.findById("image-worker").lean();
  const status = imageProcessingStatus();
  const healthy =
    status.ready && Boolean(heartbeat && new Date(heartbeat.until).getTime() > Date.now());
  const [queued, processing, failures] = await Promise.all([
    ImageJob.countDocuments({ state: "queued" }),
    ImageJob.countDocuments({ state: "processing" }),
    ImageJob.find({ businessId: owner.businessId, state: "failed" })
      .sort({ updatedAt: -1 })
      .limit(5)
      .select("error updatedAt")
      .lean(),
  ]);
  response.status(healthy ? 200 : 503).json({
    healthy,
    ...status,
    heartbeat: heartbeat?.heartbeat ?? null,
    queue: { queued, processing },
    recentFailures: failures,
  });
});
imageRouter.get("/:id", async (request, response) => {
  const owner = getOwner(request);
  // Private image access remains tenant-scoped and requires a relevant view permission.
  let permitted = false;
  for (const scope of ["catalog", "menu", "landing-page"]) {
    try {
      await allowed(request, scope, false);
      permitted = true;
      break;
    } catch {}
  }
  if (!permitted) throw new HttpError(403, "Image access denied");
  await deliver(request, response, owner.businessId);
});
