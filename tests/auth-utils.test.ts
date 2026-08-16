import { safeParse } from "valibot";
import { describe, expect, it } from "vitest";
import {
  createOpaqueToken,
  hashOpaqueToken,
  isStrongMpin,
  normalizeEmail,
  normalizePhilippinePhone,
} from "../src/lib/auth-utils.js";
import { registrationSchema } from "../src/validation/auth.js";

describe("authentication utilities", () => {
  it("normalizes supported Philippine mobile formats", () => {
    expect(normalizePhilippinePhone("0917 123 4567")).toBe("+639171234567");
    expect(normalizePhilippinePhone("+63 917 123 4567")).toBe("+639171234567");
    expect(normalizePhilippinePhone("9171234567")).toBe("+639171234567");
  });

  it("rejects invalid Philippine mobile numbers", () => {
    expect(() => normalizePhilippinePhone("12345")).toThrow("valid Philippine mobile");
  });

  it("normalizes email and hashes opaque tokens consistently", () => {
    expect(normalizeEmail(" Owner@Example.COM ")).toBe("owner@example.com");
    const token = createOpaqueToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
    expect(hashOpaqueToken(token)).not.toBe(token);
  });

  it("rejects predictable MPIN values", () => {
    expect(isStrongMpin("482951")).toBe(true);
    expect(isStrongMpin("123456")).toBe(false);
    expect(isStrongMpin("111111")).toBe(false);
    const result = safeParse(registrationSchema, {
      ownerName: "Miss V",
      email: "owner@example.com",
      phone: "09171234567",
      password: "secure-password",
      mpin: "123456",
      businessName: "Miss V Business",
      openingBalance: 0,
    });
    expect(result.success).toBe(false);
  });
});
