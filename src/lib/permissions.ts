export const permissionModules = [
  { id: "overview", name: "Overview", actions: ["view"] },
  { id: "cash-flow", name: "Cash flow", actions: ["view", "create", "edit", "delete"] },
  { id: "calendar", name: "Calendar & To-do", actions: ["view", "create", "edit", "delete"] },
  { id: "landing-page", name: "Landing Page", actions: ["view", "create", "edit", "delete"] },
  { id: "catalog", name: "Product Catalog", actions: ["view", "create", "edit", "delete"] },
  { id: "orders", name: "Customer Orders", actions: ["view", "edit"] },
  { id: "inventory", name: "Inventory", actions: ["view", "create", "edit", "delete"] },
  { id: "pigs", name: "Pigs", actions: ["view", "create", "edit", "delete"] },
  { id: "operations", name: "Farm operations", actions: ["view", "create", "edit", "delete"] },
  { id: "slaughter", name: "Slaughter", actions: ["view", "create", "edit", "delete"] },
  { id: "menu", name: "Menu", actions: ["view", "create", "edit", "delete"] },
  { id: "karenderiya", name: "Sales & cooking", actions: ["view", "create", "edit", "delete"] },
  { id: "reports", name: "Reports", actions: ["view"] },
  { id: "activity-log", name: "Activity log", actions: ["view"] },
  { id: "settings", name: "Settings & contacts", actions: ["view", "create", "edit", "delete"] },
] as const;
export type PermissionAction = "view" | "create" | "edit" | "delete";
export const allPermissions = permissionModules.flatMap((module) =>
  module.actions.map((action) => `${module.id}:${action}`),
);
// Undefined means a role created before configurable permissions existed.
export const legacyPermissions = allPermissions.filter(
  (permission) => !["landing-page", "catalog", "orders"].includes(permission.split(":")[0] ?? ""),
);
export function effectivePermissions(
  role: { permissions?: string[] } | undefined,
  highest: boolean,
): string[] {
  return highest ? [...allPermissions] : role ? [...(role.permissions ?? legacyPermissions)] : [];
}
const resourceModules: Record<string, string[]> = {
  contacts: ["settings"],
  "cash-accounts": ["cash-flow"],
  "cash-transactions": ["cash-flow"],
  expenses: ["cash-flow"],
  "pig-batches": ["pigs", "operations"],
  pigs: ["pigs"],
  "pig-measurements": ["pigs", "operations"],
  "feed-usage": ["operations"],
  "slaughter-settings": ["slaughter"],
  slaughters: ["slaughter"],
  "piggery-sales": ["operations"],
  "inventory-items": ["inventory"],
  "inventory-lots": ["inventory"],
  "inventory-movements": ["inventory"],
  recipes: ["menu"],
  "menu-items": ["menu"],
  "cooking-batches": ["karenderiya"],
  "karenderiya-sales": ["karenderiya"],
};
const operationModules: Record<string, string[]> = {
  cash: ["cash-flow"],
  expenses: ["cash-flow"],
  "karenderiya-sales": ["karenderiya"],
  "inventory-receipts": ["inventory"],
  "feed-usage": ["operations"],
  "pig-measurements": ["pigs", "operations"],
  "pig-acquisitions": ["pigs"],
  slaughters: ["slaughter"],
  "meat-transfers": ["operations", "inventory"],
  "piggery-sales": ["operations"],
  "cooking-batches": ["karenderiya"],
  "menu-recipes": ["menu"],
};
// An empty list is denied; null is reserved for authentication/public or highest-only routes.
export function requiredPermissions(rawPath: string, method = "GET"): string[] | null {
  const path = (rawPath.split("?")[0] ?? "").replace(/^\/api(?=\/)/, "");
  const [, area = "", resource = "", , operation] = path.split("/");
  if (["auth", "public", "invites", "health", "admin", "employees"].includes(area)) return null;
  let action: PermissionAction =
    method === "GET" || method === "HEAD"
      ? "view"
      : method === "POST"
        ? "create"
        : method === "DELETE"
          ? "delete"
          : "edit";
  if (area === "settings" && resource === "account") return null;
  if (area === "settings" && resource === "slaughter" && action === "view")
    return ["slaughter:view", "settings:view"];
  let modules: string[];
  if (area === "resources") modules = resourceModules[resource] ?? [];
  else if (area === "operations") modules = operationModules[resource] ?? [];
  else if (area === "calculations") {
    modules =
      resource === "slaughter"
        ? ["slaughter"]
        : resource === "menu-price"
          ? ["menu", "karenderiya"]
          : [];
    action = "view";
  } else {
    const aliases: Record<string, string> = {
      dashboard: "overview",
      "calendar-todos": "calendar",
      activity: "activity-log",
    };
    const module = aliases[area] ?? area;
    modules = permissionModules.some((item) => item.id === module) ? [module] : [];
    if (
      area === "landing-page" &&
      method === "POST" &&
      (operation === "publish" || resource === "unpublish")
    )
      action = "edit";
  }
  return modules.map((module) => `${module}:${action}`);
}
export function allowsRequest(permissions: string[], path: string, method = "GET") {
  const required = requiredPermissions(path, method);
  return (
    required === null ||
    required.some(
      (permission) =>
        permissions.includes(permission) &&
        permissions.includes(`${permission.split(":")[0]}:view`),
    )
  );
}
