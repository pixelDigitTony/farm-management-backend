import { Router } from "express";
import { getOwner } from "../middleware/auth.js";
import { getDashboard } from "../services/dashboard.service.js";

export const dashboardRouter = Router();
dashboardRouter.get("/", async (request, response) =>
  response.json(await getDashboard(getOwner(request).businessId)),
);
