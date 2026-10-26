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
  RESEND_WEBHOOK_SECRET: v.optional(v.string()),
  EMAIL_RECEIVING_DOMAIN: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.toLowerCase(),
      v.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/),
    ),
  ),
  EMAIL_PAYLOAD_SECRET: v.optional(v.pipe(v.string(), v.minLength(32))),
  LANDING_ANALYTICS_ENABLED: v.optional(v.picklist(["true", "false"]), "true"),
  ORDER_EMAIL_INBOX_ENABLED: v.optional(v.picklist(["true", "false"]), "false"),
  ORDER_MESSAGE_RETENTION_DAYS: positiveInteger(365),
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

const environment = { ...process.env };
for (const key of [
  "RESEND_API_KEY",
  "RESEND_EMAIL_FROM",
  "RESEND_WEBHOOK_SECRET",
  "EMAIL_RECEIVING_DOMAIN",
  "EMAIL_PAYLOAD_SECRET",
  "PUBLIC_SITE_BASE_DOMAIN",
  "AUTH_COOKIE_DOMAIN",
]) {
  if (environment[key]?.trim() === "") delete environment[key];
}
const result = v.safeParse(envSchema, environment);
if (!result.success) {
  // Valibot issues retain the root input object, which contains backend secrets.
  // Only report schema field names and fixed guidance; never attach the raw issues.
  const fields = [
    ...new Set(result.issues.map((issue) => String(issue.path?.[0]?.key ?? "environment"))),
  ];
  const details = fields.map((field) =>
    field === "EMAIL_RECEIVING_DOMAIN"
      ? `${field}: use a domain only (for example replies.example.com), without @, a URL scheme, or a path`
      : `${field}: invalid value; check .env.example`,
  );
  throw new Error(`Invalid environment configuration:\n${details.join("\n")}`);
}
const parsedEnv = result.output;

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

if (parsedEnv.NODE_ENV === "production") {
  if (parsedEnv.EMAIL_PROVIDER !== "resend" || !resendEmailConfigured)
    throw new Error(
      "Production email requires EMAIL_PROVIDER=resend, RESEND_API_KEY and RESEND_EMAIL_FROM",
    );
  const frontend = new URL(parsedEnv.FRONTEND_URL);
  if (frontend.protocol !== "https:" || /^(localhost|127\.|\[::1\])/.test(frontend.hostname))
    throw new Error("Production FRONTEND_URL must be a public HTTPS address");
  if (!parsedEnv.EMAIL_PAYLOAD_SECRET)
    throw new Error("Production requires EMAIL_PAYLOAD_SECRET to protect queued email payloads");
  if (
    parsedEnv.ORDER_EMAIL_INBOX_ENABLED === "true" &&
    (!parsedEnv.EMAIL_RECEIVING_DOMAIN || !parsedEnv.RESEND_WEBHOOK_SECRET)
  )
    throw new Error("Order email inbox requires EMAIL_RECEIVING_DOMAIN and RESEND_WEBHOOK_SECRET");
}

export const env = {
  ...parsedEnv,
  EMAIL_PROVIDER:
    parsedEnv.EMAIL_PROVIDER === "resend" && resendEmailConfigured
      ? ("resend" as const)
      : ("console" as const),
};
