import { HttpError } from "./http-error.js";

export type BusinessRole = { level: number; name: string };

export function addBusinessRole(
  currentRoles: BusinessRole[],
  currentOwnerRole: number,
  input: { level: number; name: string; previousOwnerRoleName?: string },
) {
  if (currentRoles.some((role) => role.level === input.level))
    throw new HttpError(409, "That role level already exists");
  const roles = currentRoles.map((role) => ({ ...role }));
  if (input.level > currentOwnerRole) {
    if (!input.previousOwnerRoleName)
      throw new HttpError(422, "Name the previous owner role before creating a higher role");
    if (input.previousOwnerRoleName.trim().toLowerCase() === "owner")
      throw new HttpError(422, "The previous role needs a name other than Owner");
    const previous = roles.find((role) => role.level === currentOwnerRole);
    if (previous) previous.name = input.previousOwnerRoleName;
    roles.push({ level: input.level, name: "Owner" });
    return {
      roles: roles.sort((a, b) => b.level - a.level),
      ownerRole: input.level,
      transferred: true,
    };
  }
  if (input.name.trim().toLowerCase() === "owner")
    throw new HttpError(422, "Only the highest role can be named Owner");
  roles.push({ level: input.level, name: input.name });
  return {
    roles: roles.sort((a, b) => b.level - a.level),
    ownerRole: currentOwnerRole,
    transferred: false,
  };
}
