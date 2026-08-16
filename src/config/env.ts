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
  EMAIL_PROVIDER: v.optional(v.picklist(["cloudflare", "console"]), "console"),
  CLOUDFLARE_ACCOUNT_ID: v.optional(v.string()),
  CLOUDFLARE_EMAIL_API_TOKEN: v.optional(v.string()),
  CLOUDFLARE_EMAIL_FROM: v.optional(v.pipe(v.string(), v.email())),
  CLOUDFLARE_EMAIL_FROM_NAME: v.optional(v.string(), "Miss V Business"),
  EMAIL_VERIFICATION_TTL_MINUTES: positiveInteger(1440),
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

export const cloudflareEmailConfigured = Boolean(
  parsedEnv.CLOUDFLARE_ACCOUNT_ID &&
    parsedEnv.CLOUDFLARE_EMAIL_API_TOKEN &&
    parsedEnv.CLOUDFLARE_EMAIL_FROM,
);

export const cloudflareEmailFallbackActive =
  parsedEnv.EMAIL_PROVIDER === "cloudflare" && !cloudflareEmailConfigured;

export const env = {
  ...parsedEnv,
  EMAIL_PROVIDER:
    parsedEnv.EMAIL_PROVIDER === "cloudflare" && cloudflareEmailConfigured
      ? ("cloudflare" as const)
      : ("console" as const),
};
