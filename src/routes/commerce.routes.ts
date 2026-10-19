import { Router } from "express";
import mongoose from "mongoose";
import * as v from "valibot";
import { assertImageReferences } from "../images/references.js";
import { HttpError } from "../lib/http-error.js";
import {
  availabilityInfo,
  availabilityScheduleSchema,
  localDateAt,
  scheduleMatchesDate,
  shiftDate,
  validLocalDate,
} from "../lib/product-availability.js";
import { inTransaction } from "../lib/transaction.js";
import { getOwner } from "../middleware/auth.js";
import { publicOrderLimiter } from "../middleware/rate-limit.js";
import {
  AuditLog,
  Business,
  CatalogDiscount,
  CatalogProduct,
  CustomerOrder,
} from "../models/index.js";
import { catalogCategories, resolveCategory } from "../services/catalog-category.service.js";
import { priceCatalogProducts, saveCatalogDiscount } from "../services/catalog-discount.service.js";
import {
  createCatalogProduct,
  createPublicOrder,
  normalizeProductInput,
  updateOrderStatus,
} from "../services/commerce.service.js";
import { catalogDiscountInput } from "../validation/catalog-discount.js";
import {
  catalogProductSchema,
  orderStatusSchema,
  publicOrderSchema,
} from "../validation/commerce.js";

export const catalogRouter = Router();
export const orderRouter = Router();
export const commercePublicRouter = Router();

catalogRouter.get("/products", async (request, response) => {
  const owner = getOwner(request);
  const now = new Date();
  const products = await CatalogProduct.find({ businessId: owner.businessId })
    .sort({ isActive: -1, name: 1 })
    .lean();
  response.set("Cache-Control", "no-store");
  response.json({
    items: (await priceCatalogProducts(owner.businessId, products)).map((product) => ({
      ...product,
      ...availabilityInfo(product, now),
    })),
    serverTime: now.toISOString(),
    timezone:
      (await Business.findById(owner.businessId).select("timezone").lean())?.timezone ??
      "Asia/Manila",
  });
});

catalogRouter.get("/categories", async (request, response) => {
  const items = await catalogCategories(getOwner(request).businessId);
  const source = request.query.sourceType;
  const search = String(request.query.search ?? "")
    .trim()
    .toLowerCase();
  const filtered = items.filter(
    (item) => (!source || item.sourceType === source) && item.name.toLowerCase().includes(search),
  );
  const offset = Math.max(0, Number(request.query.offset) || 0);
  const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 100));
  response.json({
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit,
    serverTime: new Date().toISOString(),
  });
});
catalogRouter.post("/availability-preview", async (request, response) => {
  const rule = v.parse(availabilityScheduleSchema, request.body.availabilitySchedule);
  const now = new Date();
  const start = String(request.body.start ?? localDateAt(now, rule.timezone));
  const count = Math.min(366, Math.max(1, Number(request.body.days) || 42));
  if (!validLocalDate(start)) throw new HttpError(422, "Choose a valid preview date");
  response.json({
    ...availabilityInfo({ isActive: true, availabilitySchedule: rule }, now),
    dates: Array.from({ length: count }, (_, i) => shiftDate(start, i)).filter((day) =>
      scheduleMatchesDate(rule, day),
    ),
    serverTime: now.toISOString(),
  });
});
catalogRouter.patch("/products/:id/availability", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid product id");
  const input = v.parse(
    v.strictObject({
      isActive: v.boolean(),
      availabilitySchedule: availabilityScheduleSchema,
      expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
    request.body,
  );
  const updated = await inTransaction(async () => {
    const before = await CatalogProduct.findOne({
      _id: request.params.id,
      businessId: owner.businessId,
    }).lean();
    if (!before) throw new HttpError(404, "Product was not found");
    const product = await CatalogProduct.findOneAndUpdate(
      {
        _id: before._id,
        businessId: owner.businessId,
        ...(input.expectedRevision === 1
          ? { $or: [{ revision: 1 }, { revision: { $exists: false } }] }
          : { revision: input.expectedRevision }),
      },
      {
        $set: { isActive: input.isActive, availabilitySchedule: input.availabilitySchedule },
        $inc: { revision: 1 },
      },
      { new: true, runValidators: true },
    ).lean();
    if (!product)
      throw new HttpError(
        409,
        "Availability changed in another editor. Reload before saving.",
        undefined,
        "PRODUCT_REVISION_CONFLICT",
      );
    await AuditLog.create({
      businessId: owner.businessId,
      userId: owner.userId,
      action: "UPDATE",
      targetCollection: "catalog-products",
      targetDocumentId: before._id,
      changedFields: ["isActive", "availabilitySchedule"],
      before: { isActive: before.isActive, availabilitySchedule: before.availabilitySchedule },
      after: { isActive: product.isActive, availabilitySchedule: product.availabilitySchedule },
    });
    return product;
  });
  response.json({ ...updated, ...availabilityInfo(updated) });
});

catalogRouter.get("/discounts", async (request, response) => {
  const { businessId } = getOwner(request);
  const items = await CatalogDiscount.find({ businessId }).sort({ createdAt: -1 }).lean();
  response.json({ items, serverTime: new Date().toISOString() });
});

catalogRouter.post("/discounts", async (request, response) => {
  response
    .status(201)
    .json(
      await saveCatalogDiscount(
        getOwner(request).businessId,
        v.parse(catalogDiscountInput, request.body),
      ),
    );
});

catalogRouter.put("/discounts/:id", async (request, response) => {
  response.json(
    await saveCatalogDiscount(
      getOwner(request).businessId,
      v.parse(catalogDiscountInput, request.body),
      String(request.params.id),
    ),
  );
});

catalogRouter.patch("/discounts/:id/status", async (request, response) => {
  const { businessId } = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id))
    throw new HttpError(400, "Invalid promotion id");
  const { isEnabled } = v.parse(v.object({ isEnabled: v.boolean() }), request.body);
  // Deactivation is always allowed, including expired promotions or archived products.
  if (!isEnabled) {
    const promotion = await CatalogDiscount.findOneAndUpdate(
      { _id: request.params.id, businessId },
      { $set: { isEnabled: false } },
      { new: true },
    ).lean();
    if (!promotion) throw new HttpError(404, "Promotion was not found");
    response.json(promotion);
    return;
  }
  const promotion = await CatalogDiscount.findOne({ _id: request.params.id, businessId }).lean();
  if (!promotion) throw new HttpError(404, "Promotion was not found");
  response.json(
    await saveCatalogDiscount(
      businessId,
      v.parse(catalogDiscountInput, {
        ...promotion,
        isEnabled: true,
        productIds: promotion.productIds.map(String),
        startsAt: new Date(promotion.startsAt).toISOString(),
        endsAt: new Date(promotion.endsAt).toISOString(),
      }),
      String(request.params.id),
    ),
  );
});

catalogRouter.post("/products", async (request, response) => {
  const owner = getOwner(request);
  const product = await createCatalogProduct(
    owner.businessId,
    v.parse(catalogProductSchema, request.body),
  );
  response.status(201).json(product);
});

catalogRouter.put("/products/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid product id");
  const reservedOrder = await CustomerOrder.exists({
    businessId: owner.businessId,
    stockReserved: true,
    status: { $in: ["CONFIRMED", "PROCESSING", "READY"] },
    items: {
      $elemMatch: { sourceType: "PRODUCT", sourceId: request.params.id },
    },
  });
  if (reservedOrder)
    throw new HttpError(409, "Process or cancel confirmed orders before editing this product");
  const input = normalizeProductInput(v.parse(catalogProductSchema, request.body));
  const expectedRevision =
    request.body.expectedRevision === undefined
      ? undefined
      : v.parse(v.pipe(v.number(), v.integer(), v.minValue(1)), request.body.expectedRevision);
  const category = await resolveCategory(owner.businessId, "PRODUCT", input.category);
  await assertImageReferences(input, owner.businessId);
  const product = await CatalogProduct.findOneAndUpdate(
    {
      _id: request.params.id,
      businessId: owner.businessId,
      ...(expectedRevision === undefined
        ? {}
        : expectedRevision === 1
          ? { $or: [{ revision: 1 }, { revision: { $exists: false } }] }
          : { revision: expectedRevision }),
    },
    { $set: { ...input, categoryId: category?._id }, $inc: { revision: 1 } },
    { new: true, runValidators: true },
  );
  if (!product) {
    if (
      expectedRevision !== undefined &&
      (await CatalogProduct.exists({ _id: request.params.id, businessId: owner.businessId }))
    )
      throw new HttpError(
        409,
        "Product changed; reload before saving",
        undefined,
        "PRODUCT_REVISION_CONFLICT",
      );
    throw new HttpError(404, "Product was not found");
  }
  response.json(product);
});

catalogRouter.delete("/products/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid product id");
  const product = await CatalogProduct.findOneAndUpdate(
    { _id: request.params.id, businessId: owner.businessId },
    { $set: { isActive: false, isOrderable: false }, $inc: { revision: 1 } },
    { new: true },
  );
  if (!product) throw new HttpError(404, "Product was not found");
  response.json(product);
});

orderRouter.get("/", async (request, response) => {
  const owner = getOwner(request);
  const status = typeof request.query.status === "string" ? request.query.status : "PENDING";
  const allowed = ["ALL", "PENDING", "CONFIRMED", "PROCESSING", "READY", "COMPLETED", "CANCELLED"];
  if (!allowed.includes(status)) throw new HttpError(422, "Select a valid order status");
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const filter: Record<string, unknown> = { businessId: owner.businessId };
  if (status !== "ALL") filter.status = status;
  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { orderNumber: { $regex: safe, $options: "i" } },
      { "customer.name": { $regex: safe, $options: "i" } },
      { "customer.phone": { $regex: safe, $options: "i" } },
    ];
  }
  const [items, pendingCount] = await Promise.all([
    CustomerOrder.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
    CustomerOrder.countDocuments({ businessId: owner.businessId, status: "PENDING" }),
  ]);
  response.json({ items, pendingCount });
});

orderRouter.get("/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid order id");
  const order = await CustomerOrder.findOne({
    _id: request.params.id,
    businessId: owner.businessId,
  });
  if (!order) throw new HttpError(404, "Order was not found");
  response.json(order);
});

orderRouter.patch("/:id/status", async (request, response) => {
  const owner = getOwner(request);
  response.json(
    await updateOrderStatus(
      owner.businessId,
      owner.userId,
      request.params.id,
      v.parse(orderStatusSchema, request.body),
    ),
  );
});

commercePublicRouter.post(
  "/landing-pages/:slug/orders",
  publicOrderLimiter,
  async (request, response) => {
    const result = await createPublicOrder(
      String(request.params.slug),
      v.parse(publicOrderSchema, request.body),
    );
    response.status(result.created ? 201 : 200).json({
      orderNumber: result.order.orderNumber,
      status: result.order.status,
      total: result.order.total,
      created: result.created,
    });
  },
);
