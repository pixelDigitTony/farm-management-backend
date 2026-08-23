import { parse } from "valibot";
import { describe, expect, it } from "vitest";
import {
  credentialResetSchema,
  emailChangeSchema,
  mpinChangeSchema,
  passwordChangeSchema,
  phoneChangeSchema,
  recoveryRequestSchema,
} from "../src/validation/auth.js";

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

describe("authenticated account change validation", () => {
  it("validates password, MPIN, email, and phone change payloads", () => {
    expect(
      parse(passwordChangeSchema, { currentPassword: "old-password", newPassword: "new-password" })
        .newPassword,
    ).toBe("new-password");
    expect(parse(mpinChangeSchema, { currentMpin: "195738", newMpin: "284951" }).newMpin).toBe(
      "284951",
    );
    expect(
      parse(emailChangeSchema, { currentPassword: "old-password", newEmail: "new@example.com" })
        .newEmail,
    ).toBe("new@example.com");
    expect(
      parse(phoneChangeSchema, { currentPassword: "old-password", newPhone: "09171234567" })
        .newPhone,
    ).toBe("09171234567");
  });

  it("rejects weak replacement credentials", () => {
    expect(() =>
      parse(passwordChangeSchema, { currentPassword: "old-password", newPassword: "short" }),
    ).toThrow();
    expect(() => parse(mpinChangeSchema, { currentMpin: "195738", newMpin: "111111" })).toThrow();
  });
});
