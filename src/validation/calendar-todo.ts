import * as v from "valibot";
import { isCalendarDate } from "../lib/business-date.js";

const calendarDate = v.pipe(v.string(), v.check(isCalendarDate, "Use a valid calendar date"));
const time = v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/));
const title = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120));
const notes = v.pipe(v.string(), v.trim(), v.maxLength(1_000));
const userId = v.pipe(v.string(), v.trim(), v.minLength(1));

export const calendarTodoCreateSchema = v.object({
  title,
  notes: v.optional(notes, ""),
  calendarDate,
  startTime: v.optional(v.nullable(time), null),
  category: v.optional(v.picklist(["GENERAL", "FARM", "KARENDERIYA"]), "GENERAL"),
  priority: v.optional(v.picklist(["LOW", "NORMAL", "HIGH"]), "NORMAL"),
  assignedToUserId: v.optional(v.nullable(userId), null),
});

export const calendarTodoUpdateSchema = v.object({
  title: v.optional(title),
  notes: v.optional(notes),
  calendarDate: v.optional(calendarDate),
  startTime: v.optional(v.nullable(time)),
  category: v.optional(v.picklist(["GENERAL", "FARM", "KARENDERIYA"])),
  priority: v.optional(v.picklist(["LOW", "NORMAL", "HIGH"])),
  assignedToUserId: v.optional(v.nullable(userId)),
});

export const calendarTodoStatusSchema = v.object({
  status: v.picklist(["PENDING", "IN_PROGRESS", "COMPLETED"]),
});
