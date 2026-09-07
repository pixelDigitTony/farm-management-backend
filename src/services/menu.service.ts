import type { Types } from "mongoose";
import type { InferOutput } from "valibot";
import { HttpError } from "../lib/http-error.js";
import { inTransaction } from "../lib/transaction.js";
import { InventoryItem, MenuItem, Recipe } from "../models/index.js";
import type { menuRecipeOperationSchema } from "../validation/operations.js";

type MenuRecipeInput = InferOutput<typeof menuRecipeOperationSchema>;

async function validateIngredients(businessId: Types.ObjectId, input: MenuRecipeInput) {
  const ingredientIds = [...new Set(input.recipe.ingredients.map((line) => line.inventoryItemId))];
  const available = await InventoryItem.countDocuments({
    _id: { $in: ingredientIds },
    businessId,
    isActive: true,
  });
  if (available !== ingredientIds.length)
    throw new HttpError(422, "One or more recipe ingredients are unavailable");
}

async function createMenuWithRecipeInTransaction(
  businessId: Types.ObjectId,
  input: MenuRecipeInput,
) {
  await validateIngredients(businessId, input);
  const recipe = await Recipe.create({ ...input.recipe, businessId });

  const menu = await MenuItem.create({
    ...input.menu,
    businessId,
    recipeId: recipe._id,
  });
  return { recipe, menu };
}

async function updateMenuWithRecipeInTransaction(
  businessId: Types.ObjectId,
  menuId: string,
  input: MenuRecipeInput,
) {
  await validateIngredients(businessId, input);
  const menu = await MenuItem.findOne({ _id: menuId, businessId, isActive: true });
  if (!menu) throw new HttpError(404, "Menu item was not found");
  const recipe = await Recipe.findOne({ _id: menu.recipeId, businessId, isActive: true });
  if (!recipe) throw new HttpError(404, "Menu recipe was not found");

  recipe.set(input.recipe);
  await recipe.save();

  menu.set({ ...input.menu, recipeId: recipe._id });
  await menu.save();
  return { recipe, menu };
}

export const createMenuWithRecipe = (
  ...args: Parameters<typeof createMenuWithRecipeInTransaction>
) => inTransaction(() => createMenuWithRecipeInTransaction(...args));

export const updateMenuWithRecipe = (
  ...args: Parameters<typeof updateMenuWithRecipeInTransaction>
) => inTransaction(() => updateMenuWithRecipeInTransaction(...args));
