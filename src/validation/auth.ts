import * as v from "valibot";
import { isStrongMpin } from "../lib/auth-utils.js";
import { coercedNumber } from "./helpers.js";

const trimmedString = (minimum: number, maximum: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(minimum), v.maxLength(maximum));

const mpinSchema = v.pipe(
  v.string(),
  v.regex(/^\d{6}$/, "MPIN must contain exactly 6 digits"),
  v.check(isStrongMpin, "Choose a less predictable MPIN"),
);

export const registrationSchema = v.object({
  ownerName: trimmedString(2, 100),
  email: v.pipe(v.string(), v.email()),
  phone: trimmedString(10, 30),
  password: v.pipe(v.string(), v.minLength(8), v.maxLength(100)),
  mpin: mpinSchema,
  businessName: v.optional(trimmedString(2, 120), "Miss V Business"),
  openingBalance: v.optional(coercedNumber(0), 0),
});

export const loginSchema = v.variant("method", [
  v.object({
    method: v.literal("EMAIL_PASSWORD"),
    email: v.pipe(v.string(), v.email()),
    password: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  }),
  v.object({
    method: v.literal("PHONE_MPIN"),
    phone: trimmedString(10, 30),
    mpin: v.pipe(v.string(), v.regex(/^\d{6}$/)),
  }),
]);

export const verifyEmailSchema = v.object({
  token: v.pipe(v.string(), v.minLength(32), v.maxLength(200)),
});
export const resendVerificationSchema = v.object({
  email: v.pipe(v.string(), v.email()),
});
