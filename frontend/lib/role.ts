export type Role = "admin" | "user";

export const ADMIN_GROUP = "kubeport-admin";

export function roleFromGroups(groups: readonly string[] | null | undefined): Role {
  if (!groups || groups.length === 0) return "user";
  return groups.includes(ADMIN_GROUP) ? "admin" : "user";
}
