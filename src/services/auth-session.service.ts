import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { createOpaqueToken, hashOpaqueToken } from "../lib/auth-utils.js";
import { HttpError } from "../lib/http-error.js";
import { createAccessToken } from "../middleware/auth.js";
import { AuthSession, Business, User } from "../models/index.js";

const refreshCookieName = "miss_v_refresh";
const refreshMaxAge = env.REFRESH_TOKEN_TTL_DAYS * 86_400_000;

export function getRefreshCookieOptions(request: Pick<Request, "get" | "hostname">) {
  let crossSite = false;
  const origin = request.get("origin");
  if (origin) {
    try {
      crossSite = new URL(origin).hostname !== request.hostname;
    } catch {
      crossSite = false;
    }
  }
  const sameSite = crossSite ? ("none" as const) : env.AUTH_COOKIE_SAME_SITE;
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production" || sameSite === "none",
    sameSite,
    maxAge: refreshMaxAge,
    path: "/api/auth",
    ...(crossSite ? { partitioned: true } : {}),
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  } as const;
}

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
  response.cookie(refreshCookieName, rawRefreshToken, getRefreshCookieOptions(request));
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
    clearRefreshCookie(request, response);
    throw new HttpError(401, "Session expired", undefined, "SESSION_EXPIRED");
  }
  const replacement = createOpaqueToken();
  const rotatedSession = await AuthSession.findOneAndUpdate(
    {
      _id: session._id,
      refreshTokenHash: hashOpaqueToken(rawToken),
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    },
    {
      $set: {
        refreshTokenHash: hashOpaqueToken(replacement),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + refreshMaxAge),
      },
    },
    { new: true },
  );
  if (!rotatedSession) {
    throw new HttpError(409, "Session refresh was superseded", undefined, "SESSION_SUPERSEDED");
  }
  response.cookie(refreshCookieName, replacement, getRefreshCookieOptions(request));
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
  clearRefreshCookie(request, response);
  return revokedSession;
}

export function clearRefreshCookie(request: Request, response: Response) {
  const { maxAge: _maxAge, ...clearOptions } = getRefreshCookieOptions(request);
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
