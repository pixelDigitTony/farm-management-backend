import { describe, expect, it } from "vitest";
import { isAllowedCorsOrigin } from "../src/lib/cors-origin.js";

describe("wildcard public-site CORS", () => {
  const frontend = "https://yourdomain.com";

  it("allows the owner app and one valid business subdomain", () => {
    expect(isAllowedCorsOrigin(frontend, frontend, "yourdomain.com", true)).toBe(true);
    expect(isAllowedCorsOrigin(frontend, `${frontend}/`, "yourdomain.com", true)).toBe(true);
    expect(
      isAllowedCorsOrigin(
        "https://miss-v-karenderiya.yourdomain.com",
        frontend,
        "yourdomain.com",
        true,
      ),
    ).toBe(true);
  });

  it("rejects insecure, nested, and lookalike production origins", () => {
    expect(
      isAllowedCorsOrigin(
        "http://miss-v-karenderiya.yourdomain.com",
        frontend,
        "yourdomain.com",
        true,
      ),
    ).toBe(false);
    expect(
      isAllowedCorsOrigin(
        "https://nested.miss-v-karenderiya.yourdomain.com",
        frontend,
        "yourdomain.com",
        true,
      ),
    ).toBe(false);
    expect(
      isAllowedCorsOrigin(
        "https://yourdomain.com.attacker.example",
        frontend,
        "yourdomain.com",
        true,
      ),
    ).toBe(false);
  });
});
