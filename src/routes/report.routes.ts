import { Router } from "express";
import { reportRange } from "../lib/business-date.js";
import { getOwner } from "../middleware/auth.js";
import { getReports } from "../services/report.service.js";

export const reportRouter = Router();
reportRouter.get("/", async (request, response) => {
  const range = reportRange(request.query.from, request.query.to);
  response.json(await getReports(getOwner(request).businessId, range));
});
