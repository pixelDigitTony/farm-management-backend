import * as v from "valibot";

export const coercedDate = v.pipe(v.unknown(), v.toDate(), v.date());

export function coercedNumber(minimum: number, inclusive = true) {
  return v.pipe(
    v.unknown(),
    v.toNumber(),
    v.number(),
    inclusive ? v.minValue(minimum) : v.gtValue(minimum),
  );
}
