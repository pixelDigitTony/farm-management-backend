import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";

type OwnerToken = { sub: string; businessId: string; sid: string; type: "access" };

export function requireOwner(request: Request, _response: Response, next: NextFunction) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return next(new HttpError(401, "Authentication required"));

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as OwnerToken;
    if (payload.type !== "access") throw new Error("Invalid token type");
    request.owner = {
      userId: new mongoose.Types.ObjectId(payload.sub),
      businessId: new mongoose.Types.ObjectId(payload.businessId),
    };
    next();
  } catch {
    next(new HttpError(401, "Invalid or expired session"));
  }
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
