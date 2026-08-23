import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";
import { AuthSession, Business, User } from "../models/index.js";

type OwnerToken = { sub: string; businessId: string; sid: string; type: "access" };

export async function requireOwner(request: Request, _response: Response, next: NextFunction) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return next(new HttpError(401, "Authentication required"));

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as OwnerToken;
    if (payload.type !== "access") throw new Error("Invalid token type");
    const userId = new mongoose.Types.ObjectId(payload.sub);
    const businessId = new mongoose.Types.ObjectId(payload.businessId);
    const sessionId = new mongoose.Types.ObjectId(payload.sid);
    const [session, user, business] = await Promise.all([
      AuthSession.exists({
        _id: sessionId,
        userId,
        businessId,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }),
      User.findOne({ _id: userId, businessId, isActive: true }),
      Business.exists({ _id: businessId, isArchived: { $ne: true } }),
    ]);
    if (!session || !user || !business || ["LOCKED", "DISABLED"].includes(user.status))
      throw new Error("Inactive session");
    request.owner = {
      userId,
      businessId,
      sessionId,
      role: Number(user.role),
      status: user.status,
      isApproved: user.isApproved === true,
      emailVerified: Boolean(user.emailVerifiedAt),
    };
    next();
  } catch {
    next(new HttpError(401, "Invalid or expired session"));
  }
}

export function requireApproved(request: Request, _response: Response, next: NextFunction) {
  const owner = getOwner(request);
  if (!owner.emailVerified)
    return next(new HttpError(403, "Email verification required", undefined, "EMAIL_NOT_VERIFIED"));
  if (owner.role !== 99 && (!owner.isApproved || owner.status !== "ACTIVE"))
    return next(
      new HttpError(403, "Account approval is still pending", undefined, "APPROVAL_PENDING"),
    );
  next();
}

export function requireSuperAdmin(request: Request, _response: Response, next: NextFunction) {
  const owner = getOwner(request);
  if (!owner.emailVerified || owner.role !== 99)
    return next(new HttpError(403, "Super-admin access required"));
  next();
}

export function createAccessToken(userId: string, businessId: string, sessionId: string) {
  return jwt.sign({ businessId, sid: sessionId, type: "access" }, env.JWT_SECRET, {
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
  });
}

export function getOwner(request: Request) {
  if (!request.owner) throw new HttpError(401, "Authentication required");
  return request.owner;
}
