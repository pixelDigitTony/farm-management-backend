import { endOfDay, startOfMonth } from "date-fns";
import { Router } from "express";
import { getOwner } from "../middleware/auth.js";
import { getReports } from "../services/report.service.js";

export const reportRouter = Router();
reportRouter.get("/", async (request, response) => {
  const from = request.query.from
    ? new Date(`${String(request.query.from)}T00:00:00.000+08:00`)
    : startOfMonth(new Date());
  const to = request.query.to
    ? endOfDay(new Date(`${String(request.query.to)}T00:00:00.000+08:00`))
    : endOfDay(new Date());
  response.json(await getReports(getOwner(request).businessId, { from, to }));
});
