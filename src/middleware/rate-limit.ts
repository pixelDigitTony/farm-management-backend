import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";

const jsonHandler = (_request: Request, response: Response) =>
  response.status(429).json({
    message: "Too many requests. Please wait and try again.",
    code: "RATE_LIMITED",
  });

export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler,
});

export const publicContentLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler,
});

export const publicOrderLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler,
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: jsonHandler,
});

export const registrationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler,
});

export const verificationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler,
});
