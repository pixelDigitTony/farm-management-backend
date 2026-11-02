import { Router } from "express";
import mongoose from "mongoose";
import * as v from "valibot";
import { HttpError } from "../lib/http-error.js";
import { inTransaction } from "../lib/transaction.js";
import { getOwner } from "../middleware/auth.js";
import { CatalogMyDayCampaign } from "../models/index.js";
import {
  assertMyDayReferences,
  auditMyDay,
  myDayDates,
  myDayList,
  previewMyDay,
} from "../services/catalog-my-day.service.js";
import { myDayInput, myDayInstant, myDayRevision } from "../validation/catalog-my-day.js";

export const catalogMyDayRouter = Router();
catalogMyDayRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
catalogMyDayRouter.get("/", async (req, res) => {
  const pageId = req.query.pageId ? String(req.query.pageId) : undefined;
  if (pageId && !mongoose.isValidObjectId(pageId)) throw new HttpError(422, "Invalid page ID");
  const status = req.query.status ? String(req.query.status) : undefined;
  if (status && !["Disabled", "Scheduled", "Active", "Ended"].includes(status))
    throw new HttpError(422, "Invalid status");
  const offset = Math.min(100_000, Math.max(0, Math.floor(Number(req.query.offset) || 0)));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 20)));
  res.json(await myDayList(getOwner(req).businessId, new Date(), pageId, status, offset, limit));
});
catalogMyDayRouter.post("/preview", async (req, res) => {
  const { at, ...body } = req.body;
  res.json(
    await previewMyDay(
      getOwner(req).businessId,
      v.parse(myDayInput, body),
      at === undefined ? undefined : new Date(v.parse(myDayInstant, at)),
    ),
  );
});
catalogMyDayRouter.post("/", async (req, res) => {
  const owner = getOwner(req),
    input = v.parse(myDayInput, req.body);
  const result = await inTransaction(async () => {
    await assertMyDayReferences(owner.businessId, input);
    const { expectedRevision: _revision, startNow: _startNow, ...fields } = input;
    const campaign = await CatalogMyDayCampaign.create({
      ...fields,
      ...myDayDates(input, new Date(), true),
      businessId: owner.businessId,
      createdByUserId: owner.userId,
      updatedByUserId: owner.userId,
    });
    await auditMyDay(
      owner.businessId,
      owner.userId,
      null,
      campaign.toObject(),
      campaign._id,
      "CREATE",
    );
    return campaign.toObject();
  });
  res.status(201).json(result);
});
catalogMyDayRouter.use("/:id", (req, _res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid campaign ID");
  next();
});
for (const method of ["put", "patch", "delete"] as const) {
  catalogMyDayRouter[method](method === "patch" ? "/:id/status" : "/:id", async (req, res) => {
    const owner = getOwner(req);
    const expectedRevision = v.parse(myDayRevision, req.body.expectedRevision);
    const result = await inTransaction(async () => {
      const before = await CatalogMyDayCampaign.findOne({
        _id: req.params.id,
        businessId: owner.businessId,
      }).lean();
      if (!before) throw new HttpError(404, "Campaign was not found");
      let fields: Record<string, unknown> = {};
      if (method === "put") {
        const input = v.parse(myDayInput, req.body);
        await assertMyDayReferences(owner.businessId, input);
        const { expectedRevision: _revision, startNow: _startNow, ...rest } = input;
        fields = { ...rest, ...myDayDates(input, new Date(), input.isEnabled) };
      } else if (method === "patch") {
        const input = v.parse(
          v.strictObject({ isEnabled: v.boolean(), expectedRevision: myDayRevision }),
          req.body,
        );
        if (input.isEnabled) {
          await assertMyDayReferences(owner.businessId, {
            landingPageId: String(before.landingPageId),
            productIds: before.productIds.map(String),
          });
          if (before.endsAt <= new Date())
            throw new HttpError(422, "Reschedule this expired campaign before enabling it");
        }
        fields = { isEnabled: input.isEnabled };
      } else v.parse(v.strictObject({ expectedRevision: myDayRevision }), req.body);
      const predicate = {
        _id: before._id,
        businessId: owner.businessId,
        revision: expectedRevision,
      };
      const after =
        method === "delete"
          ? await CatalogMyDayCampaign.findOneAndDelete(predicate).lean()
          : await CatalogMyDayCampaign.findOneAndUpdate(
              predicate,
              { $set: { ...fields, updatedByUserId: owner.userId }, $inc: { revision: 1 } },
              { new: true, runValidators: true },
            ).lean();
      if (!after)
        throw new HttpError(
          409,
          "Campaign changed in another editor. Reload before saving.",
          undefined,
          "MY_DAY_REVISION_CONFLICT",
        );
      await auditMyDay(
        owner.businessId,
        owner.userId,
        before,
        method === "delete" ? null : after,
        before._id,
        method === "delete" ? "DELETE" : "UPDATE",
      );
      return after;
    });
    if (method === "delete") res.status(204).send();
    else res.json(result);
  });
}
