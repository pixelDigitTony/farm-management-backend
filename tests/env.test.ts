import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries({
    DOTENV_CONFIG_PATH: "tests/.nonexistent-env-regression",
    NODE_ENV: "test",
    EMAIL_PROVIDER: "console",
    RESEND_API_KEY: "fake-api-key-redaction-marker",
    RESEND_EMAIL_FROM: "orders@example.test",
    RESEND_WEBHOOK_SECRET: "fake-webhook-redaction-marker",
    EMAIL_PAYLOAD_SECRET: "fake-payload-secret-redaction-marker",
    JWT_SECRET: "fake-jwt-secret-redaction-marker",
    MONGODB_URI: "mongodb://fake-user:fake-password@example.test/database",
    EMAIL_RECEIVING_DOMAIN: "example.test",
  })) {
    vi.stubEnv(key, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("environment validation", () => {
  it.each(["missvbusiness.online", "replies.missvbusiness.online"])(
    "accepts a receiving domain: %s",
    async (domain) => {
      vi.stubEnv("EMAIL_RECEIVING_DOMAIN", domain);
      expect((await import("../src/config/env.js")).env.EMAIL_RECEIVING_DOMAIN).toBe(domain);
    },
  );

  it("normalizes receiving-domain case and surrounding whitespace", async () => {
    vi.stubEnv("EMAIL_RECEIVING_DOMAIN", " Replies.Example.Test ");
    expect((await import("../src/config/env.js")).env.EMAIL_RECEIVING_DOMAIN).toBe(
      "replies.example.test",
    );
  });

  it("allows a blank receiving domain during partial setup", async () => {
    vi.stubEnv("EMAIL_RECEIVING_DOMAIN", " ");
    expect((await import("../src/config/env.js")).env.EMAIL_RECEIVING_DOMAIN).toBeUndefined();
  });

  it.each([
    "order@missvbusiness.online",
    "https://missvbusiness.online",
    "missvbusiness.online/replies",
    "replies..example.test",
  ])("rejects %s with domain-only guidance and no environment dump", async (input) => {
    vi.stubEnv("EMAIL_RECEIVING_DOMAIN", input);
    const error = await import("../src/config/env.js").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("EMAIL_RECEIVING_DOMAIN: use a domain only");
    const output = inspect(error, { depth: null });
    for (const value of [
      input,
      "fake-api-key-redaction-marker",
      "fake-webhook-redaction-marker",
      "fake-payload-secret-redaction-marker",
      "fake-jwt-secret-redaction-marker",
      "fake-password",
    ]) {
      expect(output).not.toContain(value);
    }
  });

  it("omits invalid values from other field errors too", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "private-invalid-provider-marker");
    vi.stubEnv("EMAIL_PAYLOAD_SECRET", "too-short-secret");
    const error = await import("../src/config/env.js").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const output = inspect(error, { depth: null });
    expect(output).toContain("EMAIL_PROVIDER: invalid value");
    expect(output).toContain("EMAIL_PAYLOAD_SECRET: invalid value");
    expect(output).not.toContain("private-invalid-provider-marker");
    expect(output).not.toContain("too-short-secret");
    expect(output).not.toContain("fake-api-key-redaction-marker");
  });
});
