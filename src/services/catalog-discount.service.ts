import { isValidObjectId, type Types } from "mongoose";
import { catalogPrice, discountStatus } from "../lib/catalog-pricing.js";
import { HttpError } from "../lib/http-error.js";
import { CatalogDiscount, CatalogProduct } from "../models/index.js";
import type { CatalogDiscountInput } from "../validation/catalog-discount.js";

export async function saveCatalogDiscount(
  businessId: Types.ObjectId,
  input: CatalogDiscountInput,
  id?: string,
) {
  const now = new Date();
  await CatalogDiscount.init();
  if (id && !isValidObjectId(id)) throw new HttpError(400, "Invalid promotion id");
  if (id && !(await CatalogDiscount.exists({ _id: id, businessId })))
    throw new HttpError(404, "Promotion was not found");
  if (new Date(input.endsAt) <= now)
    throw new HttpError(
      422,
      "Choose a future end time before saving or reactivating this promotion",
    );
  const products = await CatalogProduct.find({
    _id: { $in: input.productIds },
    businessId,
    isActive: true,
  })
    .select("_id name")
    .lean();
  if (products.length !== input.productIds.length)
    throw new HttpError(422, "Select active products belonging to your business");
  // Expired promotions no longer reserve a product's unique promotion slot.
  await CatalogDiscount.updateMany(
    { businessId, isEnabled: true, endsAt: { $lte: now } },
    { $set: { isEnabled: false } },
  );
  if (input.isEnabled) {
    const conflicts = await CatalogDiscount.find({
      businessId,
      isEnabled: true,
      productIds: { $in: input.productIds },
      ...(id ? { _id: { $ne: id } } : {}),
    }).lean();
    if (conflicts.length) {
      const conflictIds = new Set(conflicts.flatMap((entry) => entry.productIds.map(String)));
      const names = products
        .filter((product) => conflictIds.has(String(product._id)))
        .map((product) => product.name);
      throw new HttpError(
        409,
        `An enabled promotion already includes: ${names.join(", ")}. Deactivate it first.`,
      );
    }
  }
  try {
    const promotion = id
      ? await CatalogDiscount.findOneAndUpdate(
          { _id: id, businessId },
          { $set: input },
          { new: true, runValidators: true },
        ).lean()
      : (await CatalogDiscount.create({ ...input, businessId })).toObject();
    if (!promotion) throw new HttpError(404, "Promotion was not found");
    return promotion;
  } catch (error: any) {
    if (error?.code === 11000)
      throw new HttpError(
        409,
        "Another enabled promotion includes these products. Refresh and check their promotions.",
      );
    throw error;
  }
}

export async function enabledDiscounts(businessId: Types.ObjectId, productIds: unknown[]) {
  if (!productIds.length) return new Map<string, any>();
  const promotions = await CatalogDiscount.find({
    businessId,
    isEnabled: true,
    productIds: { $in: productIds },
  }).lean();
  return new Map<string, any>(
    promotions.flatMap((promotion) =>
      promotion.productIds.map((id: Types.ObjectId) => [String(id), promotion] as const),
    ),
  );
}

export function publicDiscount(promotion: any, now: Date) {
  if (!promotion) return null;
  return {
    id: String(promotion._id),
    name: promotion.name,
    type: promotion.type,
    value: promotion.value,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    isEnabled: promotion.isEnabled,
    status: discountStatus(promotion, now),
  };
}

export async function priceCatalogProducts(
  businessId: Types.ObjectId,
  products: any[],
  now = new Date(),
) {
  const discounts = await enabledDiscounts(
    businessId,
    products.map((product) => product._id),
  );
  return products.map((product) => {
    const discount = discounts.get(String(product._id));
    return {
      ...product,
      ...catalogPrice(product.basePrice, discount, now),
      discount: publicDiscount(discount, now),
      variants: (product.variants ?? []).map((variant: any) => {
        const pricing = catalogPrice(variant.price, discount, now);
        return { ...variant, ...pricing, effectivePrice: pricing.price, price: variant.price };
      }),
    };
  });
}
