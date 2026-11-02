import * as v from "valibot";
import { validLocalDate, validTimezone } from "../lib/product-availability.js";

const text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
export const myDayInstant = v.pipe(
  v.string(),
  v.check(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      validLocalDate(value.slice(0, 10)) &&
      Number.isFinite(Date.parse(value)),
    "Use an ISO timestamp with an explicit timezone offset",
  ),
);
export const myDayRevision = v.pipe(v.number(), v.integer(), v.minValue(1));
const id = v.pipe(v.string(), v.regex(/^[a-f0-9]{24}$/i, "Choose a valid item"));
export const myDayInput = v.pipe(
  v.strictObject({
    name: text(120),
    heading: text(80),
    description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(240)), ""),
    landingPageId: id,
    productIds: v.pipe(
      v.array(id),
      v.minLength(1),
      v.maxLength(10),
      v.check((ids) => new Set(ids).size === ids.length, "Select each product once"),
    ),
    timezone: v.pipe(v.string(), v.check(validTimezone, "Choose a valid timezone")),
    startsAt: v.optional(myDayInstant),
    startNow: v.optional(v.literal(true)),
    endsAt: myDayInstant,
    isEnabled: v.optional(v.boolean(), false),
    expectedRevision: v.optional(myDayRevision),
  }),
  v.check(
    (input) => Boolean(input.startsAt) !== Boolean(input.startNow),
    "Choose a start time or Start now",
  ),
);
export type MyDayInput = v.InferOutput<typeof myDayInput>;
