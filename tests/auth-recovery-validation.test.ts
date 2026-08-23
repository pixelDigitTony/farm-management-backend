import { parse } from "valibot";
import { describe, expect, it } from "vitest";
import { credentialResetSchema, recoveryRequestSchema } from "../src/validation/auth.js";

describe("credential recovery validation", () => {
  it("accepts password recovery by email and MPIN recovery by phone", () => {
    expect(
      parse(recoveryRequestSchema, { kind: "PASSWORD", email: "owner@example.com" }).kind,
    ).toBe("PASSWORD");
    expect(parse(recoveryRequestSchema, { kind: "MPIN", phone: "09171234567" }).kind).toBe("MPIN");
  });

  it("enforces password length and strong six-digit MPINs", () => {
    const token = "a".repeat(32);
    expect(() =>
      parse(credentialResetSchema, { kind: "PASSWORD", token, credential: "short" }),
    ).toThrow();
    expect(() =>
      parse(credentialResetSchema, { kind: "MPIN", token, credential: "123456" }),
    ).toThrow();
    expect(
      parse(credentialResetSchema, { kind: "MPIN", token, credential: "195738" }).credential,
    ).toBe("195738");
  });
});
