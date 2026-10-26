import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { getOwner } from "../middleware/auth.js";
import { landingStatistics, recordLandingEvents } from "../services/landing-analytics.service.js";
export const analyticsPublicRouter = Router();
export const analyticsManagementRouter = Router();
analyticsPublicRouter.post(
  "/landing-pages/:slug/events",
  rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false }),
  async (req, res) => {
    await recordLandingEvents(String(req.params.slug), req.body, req.get("user-agent"));
    res.status(202).json({ accepted: true });
  },
);
analyticsManagementRouter.get("/pages/:pageId/statistics", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await landingStatistics(getOwner(req).businessId, String(req.params.pageId), req.query));
});
