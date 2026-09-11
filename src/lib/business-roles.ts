import { HttpError } from "./http-error.js";

export type BusinessRole = { level: number; name: string; permissions?: string[] };
type RoleChange = { from: number; to: number };

function validateLevel(level: number, maximum: number) {
  if (!Number.isInteger(level) || level < 0 || level > maximum)
    throw new HttpError(422, `Role level must be an integer between 0 and ${maximum}`);
}
function result(roles: BusinessRole[], ownerRole: number, changes: RoleChange[]) {
  return {
    roles: roles.sort((a, b) => b.level - a.level),
    ownerRole,
    changes: changes.filter((change) => change.from !== change.to),
  };
}

export function addBusinessRole(
  currentRoles: BusinessRole[],
  currentOwnerRole: number,
  input: BusinessRole,
) {
  validateLevel(input.level, 97);
  const owner = currentRoles.find((role) => role.level === currentOwnerRole);
  if (!owner) throw new HttpError(409, "The business owner role is missing");
  const others = currentRoles.filter((role) => role.level !== currentOwnerRole);
  if (others.some((role) => role.level === input.level))
    throw new HttpError(409, "That role level already exists");
  const ownerRole = Math.max(currentOwnerRole, input.level + 1);
  return result(
    [...others.map((role) => ({ ...role })), { ...owner, level: ownerRole }, { ...input }],
    ownerRole,
    [{ from: currentOwnerRole, to: ownerRole }],
  );
}

export function editBusinessRole(
  currentRoles: BusinessRole[],
  currentOwnerRole: number,
  previousLevel: number,
  input: { level?: number; name: string },
) {
  const target = currentRoles.find((role) => role.level === previousLevel);
  if (!target) throw new HttpError(404, "Role was not found");
  const level = input.level ?? previousLevel;
  const highest = previousLevel === currentOwnerRole;
  validateLevel(level, highest ? 98 : 97);
  const others = currentRoles.filter(
    (role) => role.level !== currentOwnerRole && role.level !== previousLevel,
  );
  if (highest) {
    const nextHighest = Math.max(-1, ...others.map((role) => role.level));
    if (level !== previousLevel && level !== nextHighest + 1)
      throw new HttpError(
        422,
        `Owner level must be ${nextHighest + 1}, one above the next highest role`,
      );
    return result(
      currentRoles.map((role) =>
        role.level === previousLevel ? { ...role, name: input.name, level } : { ...role },
      ),
      level,
      [{ from: previousLevel, to: level }],
    );
  }
  if (others.some((role) => role.level === level))
    throw new HttpError(409, "That role level already exists");
  const ownerRole = Math.max(currentOwnerRole, level + 1);
  return result(
    currentRoles.map((role) =>
      role.level === previousLevel
        ? { ...role, name: input.name, level }
        : role.level === currentOwnerRole
          ? { ...role, level: ownerRole }
          : { ...role },
    ),
    ownerRole,
    [
      { from: previousLevel, to: level },
      { from: currentOwnerRole, to: ownerRole },
    ],
  );
}
