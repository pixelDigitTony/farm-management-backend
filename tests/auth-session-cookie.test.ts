import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { getRefreshCookieOptions } from "../src/services/auth-session.service.js";

function request(origin: string, hostname: string) {
  return {
    hostname,
    get: (name: string) => (name.toLowerCase() === "origin" ? origin : undefined),
  } as Pick<Request, "get" | "hostname">;
}

describe("refresh-session cookie options", () => {
  it("uses a partitioned SameSite=None cookie across frontend and API hosts", () => {
    const options = getRefreshCookieOptions(
      request("https://miss-v-business.vercel.app", "miss-v-api.onrender.com"),
    );

    expect(options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "none",
      partitioned: true,
      path: "/api/auth",
    });
  });

  it("preserves the configured cookie policy on the same host", () => {
    const options = getRefreshCookieOptions(request("http://localhost:5173", "localhost"));

    expect(options.sameSite).toBe("lax");
    expect(options.secure).toBe(false);
    expect("partitioned" in options).toBe(false);
  });
});
