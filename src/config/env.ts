import "dotenv/config";
import * as v from "valibot";

const positiveInteger = (fallback: number) =>
  v.optional(v.pipe(v.unknown(), v.toNumber(), v.number(), v.integer(), v.gtValue(0)), fallback);

const envSchema = v.object({
  NODE_ENV: v.optional(v.picklist(["development", "test", "production"]), "development"),
  PORT: positiveInteger(4000),
  MONGODB_URI: v.optional(v.string(), "mongodb://127.0.0.1:27017/MissVBusiness"),
  JWT_SECRET: v.optional(
    v.pipe(v.string(), v.minLength(16)),
    "development-only-change-this-secret",
  ),
  FRONTEND_URL: v.optional(v.string(), "http://localhost:5173"),
  PUBLIC_SITE_BASE_DOMAIN: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.toLowerCase(),
      v.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/),
    ),
  ),
  EMAIL_PROVIDER: v.optional(v.picklist(["resend", "console"]), "console"),
  RESEND_API_KEY: v.optional(v.string()),
  RESEND_EMAIL_FROM: v.optional(v.pipe(v.string(), v.email())),
  RESEND_EMAIL_FROM_NAME: v.optional(v.string(), "Miss V Business"),
  EMAIL_VERIFICATION_TTL_MINUTES: positiveInteger(1440),
  CREDENTIAL_RESET_TTL_MINUTES: positiveInteger(60),
  EMAIL_RESEND_COOLDOWN_SECONDS: v.optional(
    v.pipe(v.unknown(), v.toNumber(), v.number(), v.integer(), v.minValue(0)),
    60,
  ),
  EMAIL_MAX_RESENDS_PER_HOUR: positiveInteger(5),
  ACCESS_TOKEN_TTL_MINUTES: positiveInteger(15),
  REFRESH_TOKEN_TTL_DAYS: positiveInteger(30),
  AUTH_COOKIE_SAME_SITE: v.optional(v.picklist(["lax", "strict", "none"]), "lax"),
  AUTH_COOKIE_DOMAIN: v.optional(v.string()),
});

const parsedEnv = v.parse(envSchema, process.env);

if (
  parsedEnv.NODE_ENV === "production" &&
  (!process.env.JWT_SECRET || parsedEnv.JWT_SECRET === "development-only-change-this-secret")
) {
  throw new Error("Production requires an explicitly configured JWT_SECRET");
}

export const resendEmailConfigured = Boolean(
  parsedEnv.RESEND_API_KEY && parsedEnv.RESEND_EMAIL_FROM,
);

export const resendEmailFallbackActive =
  parsedEnv.EMAIL_PROVIDER === "resend" && !resendEmailConfigured;

export const env = {
  ...parsedEnv,
  EMAIL_PROVIDER:
    parsedEnv.EMAIL_PROVIDER === "resend" && resendEmailConfigured
      ? ("resend" as const)
      : ("console" as const),
};
