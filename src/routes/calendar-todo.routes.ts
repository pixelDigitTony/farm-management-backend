import { Router } from "express";
import mongoose from "mongoose";
import * as v from "valibot";
import { isCalendarDate } from "../lib/business-date.js";
import { HttpError } from "../lib/http-error.js";
import { getOwner } from "../middleware/auth.js";
import { Business, CalendarTodo, User } from "../models/index.js";
import {
  calendarTodoCreateSchema,
  calendarTodoStatusSchema,
  calendarTodoUpdateSchema,
} from "../validation/calendar-todo.js";

export const calendarTodoRouter = Router();

function validDate(value: unknown): value is string {
  return typeof value === "string" && isCalendarDate(value);
}

async function requireBusinessUser(businessId: mongoose.Types.ObjectId, userId: string | null) {
  if (!userId) return null;
  if (!mongoose.isValidObjectId(userId)) throw new HttpError(422, "Select a valid business user");
  const user = await User.findOne({
    _id: userId,
    businessId,
    isActive: true,
    isApproved: true,
    status: "ACTIVE",
  }).select("_id");
  if (!user) throw new HttpError(422, "The assigned user must be active in this business");
  return user._id;
}

async function isHighestBusinessRole(owner: ReturnType<typeof getOwner>) {
  if (owner.role === 99) return true;
  const business = await Business.findById(owner.businessId).select("ownerRole").lean();
  return Boolean(business && owner.role === Number(business.ownerRole));
}

async function canManage(todo: any, owner: ReturnType<typeof getOwner>) {
  return (
    String(todo.createdByUserId) === String(owner.userId) || (await isHighestBusinessRole(owner))
  );
}

calendarTodoRouter.get("/users", async (request, response) => {
  const owner = getOwner(request);
  const users = await User.find({
    businessId: owner.businessId,
    isActive: true,
    isApproved: true,
    status: "ACTIVE",
  })
    .select("name role")
    .sort({ name: 1 })
    .lean();
  response.json({ items: users });
});

calendarTodoRouter.get("/", async (request, response) => {
  const owner = getOwner(request);
  const start = request.query.start;
  const end = request.query.end;
  if (!validDate(start) || !validDate(end) || start > end)
    throw new HttpError(422, "Provide a valid calendar date range");
  const startDate = start;
  const endDate = end;
  const mine = request.query.mine === "true";
  const filter: Record<string, unknown> = {
    businessId: owner.businessId,
    calendarDate: { $gte: startDate, $lte: endDate },
  };
  if (mine) filter.$or = [{ createdByUserId: owner.userId }, { assignedToUserId: owner.userId }];
  const items = await CalendarTodo.find(filter)
    .sort({ calendarDate: 1, startTime: 1, createdAt: 1 })
    .lean();
  response.json({ items });
});

calendarTodoRouter.post("/", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(calendarTodoCreateSchema, request.body);
  const assignedToUserId = await requireBusinessUser(owner.businessId, input.assignedToUserId);
  const todo = await CalendarTodo.create({
    ...input,
    assignedToUserId,
    businessId: owner.businessId,
    createdByUserId: owner.userId,
  });
  response.status(201).json(todo);
});

calendarTodoRouter.patch("/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid task id");
  const todo = await CalendarTodo.findOne({ _id: request.params.id, businessId: owner.businessId });
  if (!todo) throw new HttpError(404, "To-do was not found");
  if (!(await canManage(todo, owner)))
    throw new HttpError(403, "Only the task creator or owner can edit this to-do");
  const input = v.parse(calendarTodoUpdateSchema, request.body);
  if (Object.keys(input).length === 0) throw new HttpError(422, "Provide at least one change");
  if (input.assignedToUserId !== undefined)
    todo.assignedToUserId = await requireBusinessUser(
      owner.businessId,
      input.assignedToUserId ?? null,
    );
  if (input.title !== undefined) todo.title = input.title;
  if (input.notes !== undefined) todo.notes = input.notes;
  if (input.calendarDate !== undefined) todo.calendarDate = input.calendarDate;
  if (input.startTime !== undefined) todo.startTime = input.startTime;
  if (input.category !== undefined) todo.category = input.category;
  if (input.priority !== undefined) todo.priority = input.priority;
  await todo.save();
  response.json(todo);
});

calendarTodoRouter.patch("/:id/status", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid task id");
  const todo = await CalendarTodo.findOne({ _id: request.params.id, businessId: owner.businessId });
  if (!todo) throw new HttpError(404, "To-do was not found");
  const mayUpdate =
    (await canManage(todo, owner)) || String(todo.assignedToUserId) === String(owner.userId);
  if (!mayUpdate)
    throw new HttpError(403, "Only the assignee, creator, or owner can update this status");
  const input = v.parse(calendarTodoStatusSchema, request.body);
  todo.status = input.status;
  if (input.status === "COMPLETED") {
    todo.completedAt = new Date();
    todo.completedByUserId = owner.userId;
  } else {
    todo.completedAt = null;
    todo.completedByUserId = null;
  }
  await todo.save();
  response.json(todo);
});

calendarTodoRouter.delete("/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid task id");
  const todo = await CalendarTodo.findOne({ _id: request.params.id, businessId: owner.businessId });
  if (!todo) throw new HttpError(404, "To-do was not found");
  if (!(await canManage(todo, owner)))
    throw new HttpError(403, "Only the task creator or owner can delete this to-do");
  await todo.deleteOne();
  response.status(204).send();
});
