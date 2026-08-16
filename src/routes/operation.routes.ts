import { Router } from "express";
import { parse } from "valibot";
import { getOwner } from "../middleware/auth.js";
import {
  deletePigAcquisition,
  deleteSlaughterRecord,
  postCookingBatch,
  postFeedUsage,
  postInventoryReceipt,
  postMeatTransfer,
  postPigAcquisition,
  postPiggerySale,
  postPigMeasurement,
  postSlaughterRecord,
  updateSlaughterRecord,
} from "../services/farm-operations.service.js";
import { createMenuWithRecipe, updateMenuWithRecipe } from "../services/menu.service.js";
import {
  deleteExpense,
  deleteKarenderiyaSale,
  postCash,
  postExpense,
  postKarenderiyaSale,
  updateExpense,
  updateKarenderiyaSale,
} from "../services/posting.service.js";
import {
  cashOperationSchema,
  cookingBatchOperationSchema,
  expenseOperationSchema,
  feedUsageOperationSchema,
  inventoryReceiptOperationSchema,
  karenderiyaSaleOperationSchema,
  karenderiyaSaleUpdateSchema,
  meatTransferOperationSchema,
  menuRecipeOperationSchema,
  pigAcquisitionOperationSchema,
  piggerySaleOperationSchema,
  pigMeasurementOperationSchema,
  slaughterOperationSchema,
} from "../validation/operations.js";

export const operationRouter = Router();
operationRouter.post("/cash", async (request, response) =>
  response
    .status(201)
    .json(await postCash(getOwner(request).businessId, parse(cashOperationSchema, request.body))),
);
operationRouter.post("/expenses", async (request, response) =>
  response
    .status(201)
    .json(
      await postExpense(getOwner(request).businessId, parse(expenseOperationSchema, request.body)),
    ),
);
operationRouter.patch("/expenses/:id", async (request, response) =>
  response.json(
    await updateExpense(
      getOwner(request).businessId,
      request.params.id,
      parse(expenseOperationSchema, request.body),
    ),
  ),
);
operationRouter.delete("/expenses/:id", async (request, response) => {
  await deleteExpense(getOwner(request).businessId, request.params.id);
  response.status(204).send();
});
operationRouter.post("/karenderiya-sales", async (request, response) =>
  response
    .status(201)
    .json(
      await postKarenderiyaSale(
        getOwner(request).businessId,
        parse(karenderiyaSaleOperationSchema, request.body),
      ),
    ),
);
operationRouter.patch("/karenderiya-sales/:id", async (request, response) =>
  response.json(
    await updateKarenderiyaSale(
      getOwner(request).businessId,
      request.params.id,
      parse(karenderiyaSaleUpdateSchema, request.body),
    ),
  ),
);
operationRouter.delete("/karenderiya-sales/:id", async (request, response) => {
  await deleteKarenderiyaSale(getOwner(request).businessId, request.params.id);
  response.status(204).send();
});

operationRouter.post("/inventory-receipts", async (request, response) =>
  response
    .status(201)
    .json(
      await postInventoryReceipt(
        getOwner(request).businessId,
        parse(inventoryReceiptOperationSchema, request.body),
      ),
    ),
);
operationRouter.post("/feed-usage", async (request, response) =>
  response
    .status(201)
    .json(
      await postFeedUsage(
        getOwner(request).businessId,
        parse(feedUsageOperationSchema, request.body),
      ),
    ),
);
operationRouter.post("/pig-measurements", async (request, response) =>
  response
    .status(201)
    .json(
      await postPigMeasurement(
        getOwner(request).businessId,
        parse(pigMeasurementOperationSchema, request.body),
      ),
    ),
);
operationRouter.post("/pig-acquisitions", async (request, response) =>
  response
    .status(201)
    .json(
      await postPigAcquisition(
        getOwner(request).businessId,
        parse(pigAcquisitionOperationSchema, request.body),
      ),
    ),
);
operationRouter.delete("/pig-acquisitions/:id", async (request, response) => {
  await deletePigAcquisition(getOwner(request).businessId, request.params.id);
  response.status(204).send();
});
operationRouter.post("/slaughters", async (request, response) =>
  response
    .status(201)
    .json(
      await postSlaughterRecord(
        getOwner(request).businessId,
        parse(slaughterOperationSchema, request.body),
      ),
    ),
);
operationRouter.put("/slaughters/:id", async (request, response) =>
  response.json(
    await updateSlaughterRecord(
      getOwner(request).businessId,
      request.params.id,
      parse(slaughterOperationSchema, request.body),
    ),
  ),
);
operationRouter.delete("/slaughters/:id", async (request, response) => {
  await deleteSlaughterRecord(
    getOwner(request).businessId,
    request.params.id,
    request.query.forceMissingExpense === "true",
  );
  response.status(204).send();
});
operationRouter.post("/meat-transfers", async (request, response) =>
  response
    .status(201)
    .json(
      await postMeatTransfer(
        getOwner(request).businessId,
        parse(meatTransferOperationSchema, request.body),
      ),
    ),
);
operationRouter.post("/piggery-sales", async (request, response) =>
  response
    .status(201)
    .json(
      await postPiggerySale(
        getOwner(request).businessId,
        parse(piggerySaleOperationSchema, request.body),
      ),
    ),
);
operationRouter.post("/cooking-batches", async (request, response) =>
  response
    .status(201)
    .json(
      await postCookingBatch(
        getOwner(request).businessId,
        parse(cookingBatchOperationSchema, request.body),
      ),
    ),
);
operationRouter.post("/menu-recipes", async (request, response) =>
  response
    .status(201)
    .json(
      await createMenuWithRecipe(
        getOwner(request).businessId,
        parse(menuRecipeOperationSchema, request.body),
      ),
    ),
);
operationRouter.put("/menu-recipes/:menuId", async (request, response) =>
  response.json(
    await updateMenuWithRecipe(
      getOwner(request).businessId,
      request.params.menuId,
      parse(menuRecipeOperationSchema, request.body),
    ),
  ),
);
