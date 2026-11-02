export type MyDayWindow = {
  _id: unknown;
  revision?: number;
  heading: string;
  description?: string;
  productIds: unknown[];
  startsAt: Date | string;
  endsAt: Date | string;
  isEnabled: boolean;
};
export type MyDayProduct = {
  key: string;
  sourceType: string;
  sourceId: string;
  effectiveActive?: boolean;
  isAvailable: boolean;
};
export function myDayStatus(
  campaign: Pick<MyDayWindow, "isEnabled" | "startsAt" | "endsAt">,
  now = new Date(),
) {
  if (!campaign.isEnabled) return "Disabled";
  if (+now < +new Date(campaign.startsAt)) return "Scheduled";
  return +now >= +new Date(campaign.endsAt) ? "Ended" : "Active";
}
export function myDayProductKeys(
  campaign: Pick<MyDayWindow, "productIds">,
  items: MyDayProduct[],
  goal = "SHOP",
) {
  const eligible = new Map(
    items
      .filter(
        (item) =>
          item.sourceType === "PRODUCT" &&
          item.effectiveActive !== false &&
          (goal !== "SHOP" || item.isAvailable),
      )
      .map((item) => [item.sourceId, item.key]),
  );
  return campaign.productIds.flatMap((id) => eligible.get(String(id)) ?? []);
}
export function resolveMyDay(
  campaigns: MyDayWindow[],
  items: MyDayProduct[],
  goal = "SHOP",
  now = new Date(),
) {
  const active = campaigns
    .filter((c) => myDayStatus(c, now) === "Active")
    .sort(
      (a, b) =>
        +new Date(b.startsAt) - +new Date(a.startsAt) || String(a._id).localeCompare(String(b._id)),
    );
  for (const campaign of active) {
    const productKeys = myDayProductKeys(campaign, items, goal);
    if (productKeys.length)
      return {
        id: String(campaign._id),
        revision: campaign.revision ?? 1,
        heading: campaign.heading,
        description: campaign.description ?? "",
        startsAt: new Date(campaign.startsAt).toISOString(),
        endsAt: new Date(campaign.endsAt).toISOString(),
        productKeys,
      };
  }
  return null;
}
export function myDayNextTransition(campaigns: MyDayWindow[], now: Date) {
  return (
    campaigns
      .filter((c) => c.isEnabled)
      .flatMap((c) => [new Date(c.startsAt), new Date(c.endsAt)])
      .filter((time) => time > now)
      .sort((a, b) => +a - +b)[0]
      ?.toISOString() ?? null
  );
}
