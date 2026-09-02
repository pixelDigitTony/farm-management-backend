import * as v from "valibot";

const dateTime = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.check((value) => Number.isFinite(Date.parse(value)), "Enter a valid date and time"),
);
export const catalogDiscountInput = v.pipe(
  v.object({
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
    type: v.picklist(["PERCENTAGE", "FIXED"]),
    value: v.pipe(v.number(), v.finite(), v.minValue(0.01)),
    productIds: v.pipe(
      v.array(v.pipe(v.string(), v.regex(/^[a-f\d]{24}$/i))),
      v.minLength(1),
      v.maxLength(1000),
      v.check(
        (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
        "Select each product once",
      ),
    ),
    startsAt: dateTime,
    endsAt: dateTime,
    isEnabled: v.optional(v.boolean(), true),
  }),
  v.check(
    (input) => input.type !== "PERCENTAGE" || input.value <= 100,
    "Percentage cannot exceed 100%",
  ),
  v.check(
    (input) => new Date(input.endsAt) > new Date(input.startsAt),
    "End time must be after start time",
  ),
);
export type CatalogDiscountInput = v.InferOutput<typeof catalogDiscountInput>;
