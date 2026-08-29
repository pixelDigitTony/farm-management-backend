import mongoose from "mongoose";
import { createModel, objectId, schemaOptions } from "./helpers.js";

const { Schema } = mongoose;

const calendarTodoSchema = new Schema(
  {
    businessId: objectId("Business", true),
    createdByUserId: objectId("User", true),
    assignedToUserId: { ...objectId("User"), default: null },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    notes: { type: String, trim: true, maxlength: 1_000, default: "" },
    // A local calendar date prevents an all-day task from moving a day when viewed in another timezone.
    calendarDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    startTime: { type: String, default: null, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    category: {
      type: String,
      enum: ["GENERAL", "FARM", "KARENDERIYA"],
      default: "GENERAL",
    },
    priority: { type: String, enum: ["LOW", "NORMAL", "HIGH"], default: "NORMAL" },
    status: {
      type: String,
      enum: ["PENDING", "IN_PROGRESS", "COMPLETED"],
      default: "PENDING",
    },
    completedAt: { type: Date, default: null },
    completedByUserId: { ...objectId("User"), default: null },
  },
  { ...schemaOptions, collection: "calendar_todos" },
);

calendarTodoSchema.index({ businessId: 1, calendarDate: 1 });
calendarTodoSchema.index({ businessId: 1, assignedToUserId: 1, calendarDate: 1 });
calendarTodoSchema.index({ businessId: 1, status: 1, calendarDate: 1 });

export const CalendarTodo = createModel("CalendarTodo", calendarTodoSchema);
