import type { Group, Member } from "../../api/types";

export function canViewGroupMember(group: Group | null | undefined, userId: number, self?: number) {
  if (userId === self) return true;
  if (!group) return false;
  if (group.can_manage === true && ["owner", "admin"].includes(group.my_role || "")) return true;
  // A friendship does not override a restriction on opening profiles from this group.
  return group.type === "group" && group.allow_member_add_friend === true && group.block_member_friend_requests !== true;
}

export function sortGroupMembers(rows: Member[]) {
  const rank = { owner: 0, admin: 1, member: 2 };
  return [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) =>
    (rank[a.role] ?? 2) - (rank[b.role] ?? 2) ||
    (a.remark || a.nickname || "").localeCompare(b.remark || b.nickname || "", "zh-CN") || a.id - b.id);
}
