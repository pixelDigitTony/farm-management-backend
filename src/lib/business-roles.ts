import { HttpError } from "./http-error.js";

export type BusinessRole = { level: number; name: string; permissions?: string[] };

export function addBusinessRole(
  currentRoles: BusinessRole[],
  currentOwnerRole: number,
  input: BusinessRole,
) {
  if (currentRoles.some((role) => role.level === input.level))
    throw new HttpError(409, "That role level already exists");
  return {
    roles: [...currentRoles.map((role) => ({ ...role })), { ...input }].sort(
      (a, b) => b.level - a.level,
    ),
    ownerRole: Math.max(currentOwnerRole, input.level),
    transferred: input.level > currentOwnerRole,
  };
}
