import { Router } from "express";
import mongoose from "mongoose";
import * as v from "valibot";
import { HttpError } from "../lib/http-error.js";
import { getOwner } from "../middleware/auth.js";
import { publicOrderLimiter } from "../middleware/rate-limit.js";
import { CatalogDiscount, CatalogProduct, CustomerOrder } from "../models/index.js";
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
  const products = await CatalogProduct.find({ businessId: owner.businessId })
    .sort({ isActive: -1, name: 1 })
    .lean();
  response.set("Cache-Control", "no-store");
  response.json({
    items: await priceCatalogProducts(owner.businessId, products),
    serverTime: new Date().toISOString(),
  });
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
  const product = await CatalogProduct.findOneAndUpdate(
    { _id: request.params.id, businessId: owner.businessId },
    { $set: input },
    { new: true, runValidators: true },
  );
  if (!product) throw new HttpError(404, "Product was not found");
  response.json(product);
});

catalogRouter.delete("/products/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid product id");
  const product = await CatalogProduct.findOneAndUpdate(
    { _id: request.params.id, businessId: owner.businessId },
    { $set: { isActive: false, isOrderable: false } },
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
