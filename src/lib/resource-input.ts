import { HttpError } from "./http-error.js";

const reserved = new Set(["businessId", "_id", "id", "__v", "createdAt", "updatedAt"]);
const unsafe = (key: string) =>
  key.startsWith("$") ||
  key.includes(".") ||
  ["__proto__", "prototype", "constructor"].includes(key);

function assertPlainInput(value: unknown, depth = 0): void {
  if (depth > 20) throw new HttpError(422, "Record nesting is too deep");
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (unsafe(key)) throw new HttpError(422, "Update operators and dotted fields are not allowed");
    assertPlainInput(child, depth + 1);
  }
}

/** Only ordinary field assignments cross the generic HTTP boundary. */
export function resourceUpdates(body: unknown, blocked: ReadonlySet<string> = new Set()) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(422, "A record object is required");
  assertPlainInput(body);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (reserved.has(key)) continue;
    if (blocked.has(key)) throw new HttpError(409, `Use the matching operation to change: ${key}`);
    result[key] = value;
  }
  return result;
}

function integer(value: unknown, fallback: number, name: string, maximum: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
    throw new HttpError(422, `${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum)
    throw new HttpError(422, `${name} exceeds the supported maximum of ${maximum}`);
  return parsed;
}

export function resourceQuery(query: Record<string, unknown>, fields: ReadonlySet<string>) {
  const page = integer(query.page, 1, "page", 1_000_000);
  const limit = integer(query.limit, 50, "limit", 100);
  const filter: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (["page", "limit", "sort"].includes(key)) continue;
    if (reserved.has(key) || unsafe(key) || !fields.has(key) || typeof value !== "string")
      throw new HttpError(422, `Unsupported filter: ${key}`);
    filter[key] = value;
  }
  const sortValue = query.sort ?? "-createdAt";
  if (typeof sortValue !== "string" || sortValue.length > 200)
    throw new HttpError(422, "Invalid sort");
  const sort: Record<string, 1 | -1> = {};
  for (const field of sortValue.trim().split(/\s+/)) {
    const name = field.replace(/^-/, "");
    if (unsafe(name) || !fields.has(name)) throw new HttpError(422, `Unsupported sort: ${name}`);
    sort[name] = field.startsWith("-") ? -1 : 1;
  }
  // Stable ordering prevents tied timestamps from moving between pages.
  if (!("_id" in sort)) sort._id = Object.values(sort)[0] ?? -1;
  return { page, limit, filter, sort };
}
