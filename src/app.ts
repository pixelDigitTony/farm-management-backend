import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { isAllowedCorsOrigin } from "./lib/cors-origin.js";
import { mongoJsonReplacer } from "./lib/json.js";
import { auditOwnerInteraction } from "./middleware/activity-audit.js";
import { requireApproved, requireOwner, requireSuperAdmin } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { requirePermissions } from "./middleware/permissions.js";
import { authLimiter, publicContentLimiter } from "./middleware/rate-limit.js";
import { activityRouter } from "./routes/activity.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { calculationRouter } from "./routes/calculation.routes.js";
import { calendarTodoRouter } from "./routes/calendar-todo.routes.js";
import { catalogRouter, commercePublicRouter, orderRouter } from "./routes/commerce.routes.js";
import { dashboardRouter } from "./routes/dashboard.routes.js";
import { employeeRouter, invitePublicRouter } from "./routes/employee.routes.js";
import { landingPagePublicRouter, landingPageRouter } from "./routes/landing-page.routes.js";
import { operationRouter } from "./routes/operation.routes.js";
import { reportRouter } from "./routes/report.routes.js";
import { resourceRouter } from "./routes/resource.routes.js";
import { settingsRouter } from "./routes/settings.routes.js";

export const app = express();
app.set("json replacer", mongoJsonReplacer);
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => callback(null, isAllowedCorsOrigin(origin, env.FRONTEND_URL)),
    credentials: true,
  }),
);
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
if (env.NODE_ENV !== "test") app.use(morgan("dev"));

app.get("/api/health", (_request, response) =>
  response.json({ status: "ok", database: "MissVBusiness" }),
);
app.use("/api/auth", authLimiter, authRouter);
app.use("/api/invites", authLimiter, invitePublicRouter);
app.use(
  "/api/public",
  cors({
    origin: (origin, callback) =>
      callback(
        null,
        isAllowedCorsOrigin(
          origin,
          env.FRONTEND_URL,
          env.PUBLIC_SITE_BASE_DOMAIN,
          env.NODE_ENV === "production",
        ),
      ),
    credentials: true,
  }),
  publicContentLimiter,
  landingPagePublicRouter,
  commercePublicRouter,
);
app.use("/api", auditOwnerInteraction);
app.use("/api/admin", requireOwner, requireSuperAdmin, adminRouter);
app.use("/api/employees", requireOwner, requireApproved, requirePermissions, employeeRouter);
app.use("/api/dashboard", requireOwner, requireApproved, requirePermissions, dashboardRouter);
app.use("/api/calculations", requireOwner, requireApproved, requirePermissions, calculationRouter);
app.use(
  "/api/calendar-todos",
  requireOwner,
  requireApproved,
  requirePermissions,
  calendarTodoRouter,
);
app.use("/api/landing-page", requireOwner, requireApproved, requirePermissions, landingPageRouter);
app.use("/api/catalog", requireOwner, requireApproved, requirePermissions, catalogRouter);
app.use("/api/orders", requireOwner, requireApproved, requirePermissions, orderRouter);
app.use("/api/operations", requireOwner, requireApproved, requirePermissions, operationRouter);
app.use("/api/resources", requireOwner, requireApproved, requirePermissions, resourceRouter);
app.use("/api/reports", requireOwner, requireApproved, requirePermissions, reportRouter);
app.use("/api/settings", requireOwner, requireApproved, requirePermissions, settingsRouter);
app.use("/api/activity", requireOwner, requireApproved, requirePermissions, activityRouter);
app.use(notFound);
app.use(errorHandler);
