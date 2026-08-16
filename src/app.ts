import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { mongoJsonReplacer } from "./lib/json.js";
import { auditOwnerInteraction } from "./middleware/activity-audit.js";
import { requireOwner } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { authLimiter } from "./middleware/rate-limit.js";
import { activityRouter } from "./routes/activity.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { calculationRouter } from "./routes/calculation.routes.js";
import { dashboardRouter } from "./routes/dashboard.routes.js";
import { operationRouter } from "./routes/operation.routes.js";
import { reportRouter } from "./routes/report.routes.js";
import { resourceRouter } from "./routes/resource.routes.js";
import { settingsRouter } from "./routes/settings.routes.js";

export const app = express();
app.set("json replacer", mongoJsonReplacer);
app.use(helmet());
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
if (env.NODE_ENV !== "test") app.use(morgan("dev"));

app.get("/api/health", (_request, response) =>
  response.json({ status: "ok", database: "MissVBusiness" }),
);
app.use("/api/auth", authLimiter, authRouter);
app.use("/api", auditOwnerInteraction);
app.use("/api/dashboard", requireOwner, dashboardRouter);
app.use("/api/calculations", requireOwner, calculationRouter);
app.use("/api/operations", requireOwner, operationRouter);
app.use("/api/resources", requireOwner, resourceRouter);
app.use("/api/reports", requireOwner, reportRouter);
app.use("/api/settings", requireOwner, settingsRouter);
app.use("/api/activity", requireOwner, activityRouter);
app.use(notFound);
app.use(errorHandler);
