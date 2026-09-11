import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { allowsRequest, effectivePermissions } from "../lib/permissions.js";
import { Business } from "../models/index.js";
import { getOwner } from "./auth.js";

export async function requirePermissions(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  try {
    const owner = getOwner(request);
    const business = await Business.findById(owner.businessId).select("roles ownerRole").lean();
    if (!business) throw new HttpError(403, "Business access is unavailable");
    const highest = owner.role === 99 || owner.role === Number(business.ownerRole);
    const role = business.roles.find((item: { level: number }) => item.level === owner.role);
    if (
      !highest &&
      !allowsRequest(effectivePermissions(role, false), request.originalUrl, request.method)
    )
      throw new HttpError(
        403,
        "Your role does not have permission for this action",
        undefined,
        "PERMISSION_DENIED",
      );
    next();
  } catch (error) {
    next(error);
  }
}
