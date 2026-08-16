import { endOfDay } from "date-fns";
import { Router } from "express";
import { getOwner } from "../middleware/auth.js";
import { AuditLog } from "../models/index.js";

export const activityRouter = Router();

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

activityRouter.get("/", async (request, response) => {
  const owner = getOwner(request);
  const page = positiveInteger(request.query.page, 1);
  const limit = Math.min(100, positiveInteger(request.query.limit, 25));
  const filter: Record<string, unknown> = { businessId: owner.businessId };
  if (typeof request.query.action === "string" && request.query.action !== "ALL")
    filter.action = request.query.action;
  if (typeof request.query.outcome === "string" && request.query.outcome !== "ALL")
    filter.outcome = request.query.outcome;
  if (typeof request.query.from === "string" || typeof request.query.to === "string") {
    filter.createdAt = {
      ...(typeof request.query.from === "string"
        ? { $gte: new Date(`${request.query.from}T00:00:00.000+08:00`) }
        : {}),
      ...(typeof request.query.to === "string"
        ? { $lte: endOfDay(new Date(`${request.query.to}T00:00:00.000+08:00`)) }
        : {}),
    };
  }
  if (typeof request.query.search === "string" && request.query.search.trim()) {
    const safe = request.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { targetCollection: { $regex: safe, $options: "i" } },
      { requestPath: { $regex: safe, $options: "i" } },
      { errorMessage: { $regex: safe, $options: "i" } },
    ];
  }
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  response.json({ items, page, limit, total, pages: Math.ceil(total / limit) });
});
