import { decimal, moneyString } from "./decimal.js";

export type DiscountRule = {
  name: string;
  type: "PERCENTAGE" | "FIXED";
  value: number;
  startsAt: Date | string;
  endsAt: Date | string;
  isEnabled: boolean;
};

export function discountStatus(discount: DiscountRule, now: Date) {
  if (now >= new Date(discount.endsAt)) return "EXPIRED";
  if (!discount.isEnabled) return "INACTIVE";
  return now < new Date(discount.startsAt) ? "SCHEDULED" : "ACTIVE";
}

export function catalogPrice(
  original: Parameters<typeof decimal>[0],
  discount: DiscountRule | null | undefined,
  now: Date,
) {
  const base = decimal(moneyString(original));
  const reduction = !discount
    ? decimal(0)
    : discount.type === "PERCENTAGE"
      ? base.times(discount.value).dividedBy(100)
      : decimal(discount.value);
  const discounted = base.minus(reduction).clamp(0, base).toDecimalPlaces(2);
  const active = Boolean(discount && discountStatus(discount, now) === "ACTIVE");
  const price = active ? discounted : base;
  return {
    originalPrice: moneyString(base),
    discountedPrice: moneyString(discounted),
    price: moneyString(price),
    discountAmount: moneyString(base.minus(price)),
    active,
  };
}
