import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { createOpaqueToken, hashOpaqueToken } from "../lib/auth-utils.js";
import { HttpError } from "../lib/http-error.js";
import { createAccessToken } from "../middleware/auth.js";
import { AuthSession, Business, User } from "../models/index.js";

const refreshCookieName = "miss_v_refresh";
const refreshMaxAge = env.REFRESH_TOKEN_TTL_DAYS * 86_400_000;

const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production" || env.AUTH_COOKIE_SAME_SITE === "none",
  sameSite: env.AUTH_COOKIE_SAME_SITE,
  maxAge: refreshMaxAge,
  path: "/api/auth",
  ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
} as const;

export async function createSession(
  user: { _id: unknown; id: string; businessId: unknown },
  loginMethod: "EMAIL_PASSWORD" | "PHONE_MPIN",
  request: Request,
  response: Response,
) {
  const rawRefreshToken = createOpaqueToken();
  const session = await AuthSession.create({
    userId: user._id,
    businessId: user.businessId,
    refreshTokenHash: hashOpaqueToken(rawRefreshToken),
    loginMethod,
    ipAddress: request.ip ?? null,
    userAgent: request.get("user-agent") ?? null,
    expiresAt: new Date(Date.now() + refreshMaxAge),
  });
  response.cookie(refreshCookieName, rawRefreshToken, cookieOptions);
  return createAccessToken(user.id, String(user.businessId), session.id);
}

export async function rotateSession(request: Request, response: Response) {
  const rawToken = request.cookies?.[refreshCookieName];
  if (!rawToken) throw new HttpError(401, "Session expired", undefined, "SESSION_EXPIRED");
  const session = await AuthSession.findOne({
    refreshTokenHash: hashOpaqueToken(rawToken),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).select("+refreshTokenHash");
  if (!session) {
    clearRefreshCookie(response);
    throw new HttpError(401, "Session expired", undefined, "SESSION_EXPIRED");
  }
  const user = await User.findOne({
    _id: session.userId,
    isActive: true,
    status: { $nin: ["LOCKED", "DISABLED"] },
  });
  const businessAvailable = user
    ? await Business.exists({ _id: user.businessId, isArchived: { $ne: true } })
    : null;
  if (!user || !businessAvailable) {
    session.revokedAt = new Date();
    session.revokeReason = "SECURITY";
    await session.save();
    clearRefreshCookie(response);
    throw new HttpError(401, "Session expired", undefined, "SESSION_EXPIRED");
  }
  const replacement = createOpaqueToken();
  session.refreshTokenHash = hashOpaqueToken(replacement);
  session.lastUsedAt = new Date();
  session.expiresAt = new Date(Date.now() + refreshMaxAge);
  await session.save();
  response.cookie(refreshCookieName, replacement, cookieOptions);
  return {
    token: createAccessToken(user.id, String(user.businessId), session.id),
    owner: publicOwner(user),
  };
}

export async function revokeSession(request: Request, response: Response) {
  const rawToken = request.cookies?.[refreshCookieName];
  let revokedSession = null;
  if (rawToken) {
    revokedSession = await AuthSession.findOneAndUpdate(
      { refreshTokenHash: hashOpaqueToken(rawToken), revokedAt: null },
      { $set: { revokedAt: new Date(), revokeReason: "LOGOUT" } },
      { new: true },
    );
  }
  clearRefreshCookie(response);
  return revokedSession;
}

export function clearRefreshCookie(response: Response) {
  const { maxAge: _maxAge, ...clearOptions } = cookieOptions;
  response.clearCookie(refreshCookieName, clearOptions);
}

export function publicOwner(user: {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: number;
  status: string;
  isApproved: boolean;
  emailVerifiedAt?: Date | null;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: Number(user.role),
    status: user.status,
    isApproved: user.isApproved === true,
    emailVerified: Boolean(user.emailVerifiedAt),
  };
}
