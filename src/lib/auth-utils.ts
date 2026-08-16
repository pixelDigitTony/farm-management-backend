import { createHash, randomBytes } from "node:crypto";

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function normalizePhilippinePhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  let local: string;
  if (digits.startsWith("63")) local = digits.slice(2);
  else if (digits.startsWith("0")) local = digits.slice(1);
  else local = digits;
  const normalized = `+63${local}`;
  if (!/^\+639\d{9}$/.test(normalized)) {
    throw new Error("Enter a valid Philippine mobile number");
  }
  return normalized;
}

const weakMpins = new Set([
  "000000",
  "111111",
  "222222",
  "333333",
  "444444",
  "555555",
  "666666",
  "777777",
  "888888",
  "999999",
  "123456",
  "654321",
]);

export function isStrongMpin(mpin: string) {
  return /^\d{6}$/.test(mpin) && !weakMpins.has(mpin);
}

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
