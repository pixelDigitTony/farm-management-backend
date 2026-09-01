import { randomUUID } from "node:crypto";
import mongoose, { type Types } from "mongoose";
import * as v from "valibot";
import { decimal, moneyString } from "../lib/decimal.js";
import { HttpError } from "../lib/http-error.js";
import { Business, CatalogProduct, CustomerOrder, LandingPage, MenuItem } from "../models/index.js";
import type { CatalogProductInput, PublicOrderInput } from "../validation/commerce.js";
import {
  defaultLandingPageCommerceSettings,
  landingPageCommerceSettingsSchema,
} from "../validation/landing-page.js";

export type CatalogItemReference = { sourceType: "MENU_ITEM" | "PRODUCT"; sourceId: string };

export function catalogItemKey(reference: CatalogItemReference) {
  return `${reference.sourceType}:${reference.sourceId}`;
}

function productAvailable(product: any) {
  if (!product.isActive || !product.isOrderable) return false;
  if (product.variants?.length)
    return product.variants.some(
      (variant: any) =>
        variant.isAvailable &&
        (variant.availableQuantity === null || Number(variant.availableQuantity) > 0),
    );
  return product.availableQuantity === null || Number(product.availableQuantity) > 0;
}

function publicMenuItem(item: any) {
  const sourceId = String(item._id);
  const mediaUrls = [
    ...(item.mediaUrls ?? []),
    ...(item.googleDriveUrls ?? []),
    ...(item.googleDriveUrl ? [item.googleDriveUrl] : []),
  ];
  return {
    key: catalogItemKey({ sourceType: "MENU_ITEM", sourceId }),
    sourceType: "MENU_ITEM" as const,
    sourceId,
    name: item.name,
    description: "",
    category: item.category ?? "Food",
    productType: "FOOD" as const,
    mediaUrls,
    price: item.sellingPricePerServing,
    variants: [],
    isFeatured: false,
    isAvailable: item.isAvailable === true,
  };
}

function publicProduct(product: any) {
  const sourceId = String(product._id);
  return {
    key: catalogItemKey({ sourceType: "PRODUCT", sourceId }),
    sourceType: "PRODUCT" as const,
    sourceId,
    name: product.name,
    description: product.description ?? "",
    category: product.category ?? "",
    productType: product.productType,
    mediaUrls: product.mediaUrls ?? [],
    price: product.basePrice,
    variants: (product.variants ?? []).map((variant: any) => ({
      variantId: variant.variantId,
      name: variant.name,
      attributes: variant.attributes ?? [],
      price: variant.price,
      isAvailable:
        variant.isAvailable === true &&
        (variant.availableQuantity === null || Number(variant.availableQuantity) > 0),
    })),
    isFeatured: product.isFeatured === true,
    isAvailable: productAvailable(product),
  };
}

export async function getBuilderCatalogItems(businessId: Types.ObjectId) {
  const [menus, products] = await Promise.all([
    MenuItem.find({ businessId, isActive: true })
      .select(
        "name category mediaUrls googleDriveUrl googleDriveUrls sellingPricePerServing isAvailable",
      )
      .sort({ name: 1 })
      .lean(),
    CatalogProduct.find({ businessId, isActive: true }).sort({ name: 1 }).lean(),
  ]);
  return [...menus.map(publicMenuItem), ...products.map(publicProduct)].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export async function getPublicCatalogItems(
  businessId: Types.ObjectId,
  references: CatalogItemReference[],
) {
  const unique = new Map(references.map((reference) => [catalogItemKey(reference), reference]));
  const menuIds = [...unique.values()]
    .filter((reference) => reference.sourceType === "MENU_ITEM")
    .map((reference) => reference.sourceId);
  const productIds = [...unique.values()]
    .filter((reference) => reference.sourceType === "PRODUCT")
    .map((reference) => reference.sourceId);
  const [menus, products] = await Promise.all([
    MenuItem.find({ _id: { $in: menuIds }, businessId, isActive: true })
      .select(
        "name category mediaUrls googleDriveUrl googleDriveUrls sellingPricePerServing isAvailable",
      )
      .lean(),
    CatalogProduct.find({ _id: { $in: productIds }, businessId, isActive: true }).lean(),
  ]);
  const resolved = new Map(
    [...menus.map(publicMenuItem), ...products.map(publicProduct)].map((item) => [item.key, item]),
  );
  return [...unique.keys()].flatMap((key) => {
    const item = resolved.get(key);
    return item ? [item] : [];
  });
}

export function normalizeProductInput(input: CatalogProductInput) {
  return {
    ...input,
    variants: input.variants.map((variant) => ({
      ...variant,
      variantId: variant.variantId || randomUUID(),
    })),
  };
}

export async function createCatalogProduct(businessId: Types.ObjectId, input: CatalogProductInput) {
  return CatalogProduct.create({
    ...normalizeProductInput(input),
    businessId,
    productCode: `PRD-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
  });
}

function publishedSections(snapshot: any) {
  if (Array.isArray(snapshot?.sections)) return snapshot.sections;
  return [
    { enabled: true, components: Array.isArray(snapshot?.components) ? snapshot.components : [] },
  ];
}

export function selectedCatalogReferences(snapshot: any): CatalogItemReference[] {
  const references: CatalogItemReference[] = [];
  for (const section of publishedSections(snapshot)) {
    if (section?.enabled === false || !Array.isArray(section?.components)) continue;
    for (const component of section.components) {
      if (component?.enabled === false) continue;
      if (component?.type === "MENU" && Array.isArray(component?.content?.menuItemIds)) {
        for (const sourceId of component.content.menuItemIds)
          references.push({ sourceType: "MENU_ITEM", sourceId: String(sourceId) });
      }
      if (component?.type === "CATALOG" && Array.isArray(component?.content?.catalogItemRefs)) {
        for (const reference of component.content.catalogItemRefs) {
          if (
            (reference?.sourceType === "MENU_ITEM" || reference?.sourceType === "PRODUCT") &&
            typeof reference?.sourceId === "string"
          )
            references.push(reference);
        }
      }
    }
  }
  return [
    ...new Map(references.map((reference) => [catalogItemKey(reference), reference])).values(),
  ];
}

async function publishedOrderingContext(slug: string) {
  const page = await LandingPage.findOne({
    slug: slug.toLowerCase(),
    isPublished: true,
    publishedSnapshot: { $ne: null },
  }).lean();
  if (!page) throw new HttpError(404, "Published page was not found");
  const business = await Business.exists({ _id: page.businessId, isArchived: { $ne: true } });
  if (!business) throw new HttpError(404, "Published page was not found");
  const snapshot = page.publishedSnapshot as Record<string, unknown>;
  const commerce = v.parse(
    landingPageCommerceSettingsSchema,
    snapshot.commerce ?? defaultLandingPageCommerceSettings,
  );
  return { page, commerce, allowedReferences: selectedCatalogReferences(snapshot) };
}

function normalizedLines(lines: PublicOrderInput["items"]) {
  const grouped = new Map<string, PublicOrderInput["items"][number]>();
  for (const line of lines) {
    const key = `${line.sourceType}:${line.sourceId}:${line.variantId ?? ""}`;
    const existing = grouped.get(key);
    const quantity = (existing?.quantity ?? 0) + line.quantity;
    if (quantity > 99) throw new HttpError(422, "Order quantity cannot exceed 99 per item");
    grouped.set(key, { ...line, quantity });
  }
  return [...grouped.values()];
}

function firstMedia(item: any) {
  return item.mediaUrls?.[0] ?? item.googleDriveUrls?.[0] ?? item.googleDriveUrl ?? "";
}

export async function createPublicOrder(slug: string, input: PublicOrderInput) {
  const { page, commerce, allowedReferences } = await publishedOrderingContext(slug);
  const existing = await CustomerOrder.findOne({
    businessId: page.businessId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) return { order: existing, created: false };
  if (!commerce.orderingEnabled) throw new HttpError(409, "Online ordering is currently disabled");
  if (!commerce.fulfillmentMethods.includes(input.fulfillmentMethod))
    throw new HttpError(422, "Select an available fulfillment method");
  if (!commerce.paymentMethods.includes(input.paymentMethod))
    throw new HttpError(422, "Select an available payment method");

  const allowed = new Set(allowedReferences.map(catalogItemKey));
  const lines = normalizedLines(input.items);
  for (const line of lines) {
    if (!mongoose.isValidObjectId(line.sourceId)) throw new HttpError(422, "Select valid products");
    if (!allowed.has(catalogItemKey(line)))
      throw new HttpError(422, "One or more products are not available from this page");
  }

  const menuIds = lines
    .filter((line) => line.sourceType === "MENU_ITEM")
    .map((line) => line.sourceId);
  const productIds = lines
    .filter((line) => line.sourceType === "PRODUCT")
    .map((line) => line.sourceId);
  const [menus, products] = await Promise.all([
    MenuItem.find({
      _id: { $in: menuIds },
      businessId: page.businessId,
      isActive: true,
      isAvailable: true,
    }),
    CatalogProduct.find({
      _id: { $in: productIds },
      businessId: page.businessId,
      isActive: true,
      isOrderable: true,
    }),
  ]);

  const orderItems = lines.map((line) => {
    if (line.sourceType === "MENU_ITEM") {
      const menu = menus.find((candidate) => candidate.id === line.sourceId);
      if (!menu) throw new HttpError(422, "One or more menu items are unavailable");
      if (line.variantId) throw new HttpError(422, `${menu.name} does not use product variants`);
      const price = decimal(menu.sellingPricePerServing?.toString());
      return {
        sourceType: line.sourceType,
        sourceId: menu._id,
        variantId: null,
        nameSnapshot: menu.name,
        categorySnapshot: menu.category ?? "Food",
        variantSnapshot: "",
        mediaUrlSnapshot: firstMedia(menu),
        unitPrice: price.toString(),
        quantity: line.quantity,
        lineTotal: price.times(line.quantity).toString(),
      };
    }

    const product = products.find((candidate) => candidate.id === line.sourceId);
    if (!product || !productAvailable(product))
      throw new HttpError(422, "One or more products are unavailable");
    const variants = product.variants ?? [];
    const variant = line.variantId
      ? variants.find((candidate: any) => candidate.variantId === line.variantId)
      : undefined;
    if (variants.length && !variant)
      throw new HttpError(422, `Select an option for ${product.name}`);
    if (!variants.length && line.variantId)
      throw new HttpError(422, `${product.name} does not use product variants`);
    if (
      variant &&
      (!variant.isAvailable ||
        (variant.availableQuantity !== null && Number(variant.availableQuantity) < line.quantity))
    )
      throw new HttpError(422, `${variant.name} is unavailable in the requested quantity`);
    if (
      !variant &&
      product.availableQuantity !== null &&
      Number(product.availableQuantity) < line.quantity
    )
      throw new HttpError(422, `${product.name} is unavailable in the requested quantity`);
    const price = decimal(variant?.price?.toString() ?? product.basePrice?.toString());
    return {
      sourceType: line.sourceType,
      sourceId: product._id,
      variantId: variant?.variantId ?? null,
      nameSnapshot: product.name,
      categorySnapshot: product.category ?? "",
      variantSnapshot: variant?.name ?? "",
      mediaUrlSnapshot: product.mediaUrls?.[0] ?? "",
      unitPrice: price.toString(),
      quantity: line.quantity,
      lineTotal: price.times(line.quantity).toString(),
    };
  });

  const subtotal = orderItems.reduce((total, item) => total.plus(item.lineTotal), decimal(0));
  if (subtotal.lessThan(commerce.minimumOrder))
    throw new HttpError(422, `Minimum order is ${moneyString(decimal(commerce.minimumOrder))}`);
  const deliveryFee =
    input.fulfillmentMethod === "DELIVERY" ? decimal(commerce.deliveryFee) : decimal(0);
  const total = subtotal.plus(deliveryFee);
  try {
    const order = await CustomerOrder.create({
      businessId: page.businessId,
      landingPageId: page._id,
      orderNumber: `WEB-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
      idempotencyKey: input.idempotencyKey,
      sourceSlugSnapshot: page.slug,
      customer: input.customer,
      fulfillmentMethod: input.fulfillmentMethod,
      deliveryAddress: input.deliveryAddress,
      paymentMethod: input.paymentMethod,
      items: orderItems,
      subtotal: moneyString(subtotal),
      deliveryFee: moneyString(deliveryFee),
      total: moneyString(total),
      customerNotes: input.customerNotes,
      status: "PENDING",
      statusHistory: [{ status: "PENDING", changedAt: new Date(), note: "Order submitted" }],
    });
    return { order, created: true };
  } catch (error: any) {
    if (error?.code === 11000) {
      const duplicate = await CustomerOrder.findOne({
        businessId: page.businessId,
        idempotencyKey: input.idempotencyKey,
      });
      if (duplicate) return { order: duplicate, created: false };
    }
    throw error;
  }
}

async function reserveOrderStock(order: any) {
  const changed: Array<{ productId: Types.ObjectId; variantId?: string; quantity: number }> = [];
  try {
    for (const item of order.items) {
      if (item.sourceType === "MENU_ITEM") {
        const available = await MenuItem.exists({
          _id: item.sourceId,
          businessId: order.businessId,
          isActive: true,
          isAvailable: true,
        });
        if (!available) throw new HttpError(422, `${item.nameSnapshot} is no longer available`);
        continue;
      }
      const product = await CatalogProduct.findOne({
        _id: item.sourceId,
        businessId: order.businessId,
        isActive: true,
        isOrderable: true,
      });
      if (!product) throw new HttpError(422, `${item.nameSnapshot} is no longer available`);
      if (item.variantId) {
        const variant = product.variants.find(
          (candidate: any) => candidate.variantId === item.variantId,
        );
        if (!variant?.isAvailable)
          throw new HttpError(422, `${item.nameSnapshot} ${item.variantSnapshot} is unavailable`);
        if (variant.availableQuantity !== null) {
          const updated = await CatalogProduct.updateOne(
            {
              _id: product._id,
              businessId: order.businessId,
              variants: {
                $elemMatch: {
                  variantId: item.variantId,
                  isAvailable: true,
                  availableQuantity: { $gte: item.quantity },
                },
              },
            },
            { $inc: { "variants.$[variant].availableQuantity": -item.quantity } },
            { arrayFilters: [{ "variant.variantId": item.variantId }] },
          );
          if (!updated.modifiedCount)
            throw new HttpError(422, `${item.nameSnapshot} is unavailable in that quantity`);
          changed.push({
            productId: product._id,
            variantId: item.variantId,
            quantity: item.quantity,
          });
        }
      } else if (product.availableQuantity !== null) {
        const updated = await CatalogProduct.updateOne(
          {
            _id: product._id,
            businessId: order.businessId,
            availableQuantity: { $gte: item.quantity },
          },
          { $inc: { availableQuantity: -item.quantity } },
        );
        if (!updated.modifiedCount)
          throw new HttpError(422, `${item.nameSnapshot} is unavailable in that quantity`);
        changed.push({ productId: product._id, quantity: item.quantity });
      }
    }
  } catch (error) {
    await restoreStock(order.businessId, changed);
    throw error;
  }
}

async function restoreStock(
  businessId: Types.ObjectId,
  items: Array<{ productId: Types.ObjectId; variantId?: string; quantity: number }>,
) {
  for (const item of items) {
    if (item.variantId)
      await CatalogProduct.updateOne(
        { _id: item.productId, businessId },
        { $inc: { "variants.$[variant].availableQuantity": item.quantity } },
        { arrayFilters: [{ "variant.variantId": item.variantId }] },
      );
    else
      await CatalogProduct.updateOne(
        { _id: item.productId, businessId },
        { $inc: { availableQuantity: item.quantity } },
      );
  }
}

async function restoreOrderStock(order: any) {
  const items = order.items
    .filter((item: any) => item.sourceType === "PRODUCT")
    .map((item: any) => ({
      productId: item.sourceId,
      variantId: item.variantId ?? undefined,
      quantity: item.quantity,
    }));
  for (const item of items) {
    const product = await CatalogProduct.findOne({
      _id: item.productId,
      businessId: order.businessId,
    }).select("availableQuantity variants");
    if (!product) continue;
    if (item.variantId) {
      const variant = product.variants.find(
        (candidate: any) => candidate.variantId === item.variantId,
      );
      if (variant?.availableQuantity !== null) await restoreStock(order.businessId, [item]);
    } else if (product.availableQuantity !== null) await restoreStock(order.businessId, [item]);
  }
}

const transitions: Record<string, string[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["READY", "CANCELLED"],
  READY: ["COMPLETED", "CANCELLED"],
};

export function isOrderTransitionAllowed(current: string, next: string) {
  return transitions[current]?.includes(next) === true;
}

export async function updateOrderStatus(
  businessId: Types.ObjectId,
  userId: Types.ObjectId,
  orderId: string,
  input: { status: string; note?: string; cancellationReason?: string },
) {
  if (!mongoose.isValidObjectId(orderId)) throw new HttpError(400, "Invalid order id");
  const current = await CustomerOrder.findOne({ _id: orderId, businessId });
  if (!current) throw new HttpError(404, "Order was not found");
  if (!isOrderTransitionAllowed(current.status, input.status))
    throw new HttpError(409, `Order cannot move from ${current.status} to ${input.status}`);
  if (input.status === "CANCELLED" && !input.cancellationReason?.trim())
    throw new HttpError(422, "Enter a cancellation reason");
  const lock = randomUUID();
  const order = await CustomerOrder.findOneAndUpdate(
    {
      _id: orderId,
      businessId,
      status: current.status,
      transitionLock: null,
    },
    { $set: { transitionLock: lock } },
    { new: true },
  );
  if (!order) throw new HttpError(409, "This order is already being updated");

  let reservedDuringTransition = false;
  let restoredDuringTransition = false;
  try {
    if (input.status === "CONFIRMED") {
      await reserveOrderStock(order);
      reservedDuringTransition = true;
      order.stockReserved = true;
      order.confirmedAt = new Date();
    }
    if (input.status === "CANCELLED") {
      if (order.stockReserved) {
        await restoreOrderStock(order);
        restoredDuringTransition = true;
      }
      order.stockReserved = false;
      order.cancellationReason = input.cancellationReason?.trim() ?? "";
      order.cancelledAt = new Date();
    }
    if (input.status === "COMPLETED") {
      order.completedAt = new Date();
      order.stockReserved = false;
    }
    order.status = input.status;
    order.transitionLock = null;
    order.statusHistory.push({
      status: input.status,
      changedAt: new Date(),
      changedByUserId: userId,
      note: input.note?.trim() ?? input.cancellationReason?.trim() ?? "",
    });
    await order.save();
    return order;
  } catch (error) {
    if (reservedDuringTransition) await restoreOrderStock(order);
    if (restoredDuringTransition) await reserveOrderStock(order);
    await CustomerOrder.updateOne(
      { _id: orderId, businessId, transitionLock: lock },
      { $set: { transitionLock: null } },
    );
    throw error;
  }
}
