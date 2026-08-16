import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { AuditLog } from "../models/index.js";

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function actionFor(method: string) {
  if (method === "DELETE") return "DELETE" as const;
  if (method === "PUT" || method === "PATCH") return "UPDATE" as const;
  return "POST" as const;
}

function targetFromPath(path: string) {
  const segments = path.split("/").filter(Boolean);
  const apiIndex = segments.indexOf("api");
  const relevant = apiIndex >= 0 ? segments.slice(apiIndex + 1) : segments;
  const possibleId = relevant.at(-1);
  return {
    collection: relevant
      .filter((segment) => !mongoose.isValidObjectId(segment))
      .slice(0, 2)
      .join("/"),
    documentId: possibleId && mongoose.isValidObjectId(possibleId) ? possibleId : undefined,
  };
}

export function auditOwnerInteraction(request: Request, response: Response, next: NextFunction) {
  if (!mutationMethods.has(request.method)) return next();
  let responseMessage: string | undefined;
  const originalJson = response.json.bind(response);
  response.json = ((body: unknown) => {
    if (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
    )
      responseMessage = body.message;
    return originalJson(body);
  }) as Response["json"];

  response.once("finish", () => {
    const owner = request.owner;
    if (!owner) return;
    const requestPath = request.originalUrl.split("?")[0] ?? request.path;
    const target = targetFromPath(requestPath);
    void AuditLog.create({
      businessId: owner.businessId,
      userId: owner.userId,
      action: actionFor(request.method),
      targetCollection: target.collection || "unknown",
      targetDocumentId: target.documentId,
      changedFields:
        request.body && typeof request.body === "object" ? Object.keys(request.body) : [],
      requestMethod: request.method,
      requestPath,
      responseStatus: response.statusCode,
      outcome: response.statusCode >= 400 ? "FAILED" : "SUCCESS",
      errorMessage: response.statusCode >= 400 ? responseMessage : undefined,
      ipAddress: request.ip,
      userAgent: request.get("user-agent"),
    }).catch((error) => console.error("Failed to record owner activity", error));
  });
  next();
}
