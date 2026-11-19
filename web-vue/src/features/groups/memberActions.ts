import type { Group, Member } from "../../api/types";
import type { Chat } from "../../composables/useChat";

export type MemberManagementAction = "role" | "mute" | "remove" | "transfer";
export type MemberSocialAction = "profile" | "chat" | "add";
export type MemberAction = MemberManagementAction | MemberSocialAction;

export const isMemberSocialAction = (
  action: MemberAction,
): action is MemberSocialAction => ["profile", "chat", "add"].includes(action);

export async function manageGroupMember(
  chat: Chat,
  conversationId: number,
  memberId: number,
  action: MemberManagementAction,
) {
  const context = await chat.api<{ profile: Group; items: Member[] }>(
    "/conversations/members/context?" + new URLSearchParams({
      conversation_id: String(conversationId), user_id: String(memberId),
    }),
  );
  if (chat.active.value?.id !== conversationId) return false;
  const { profile } = context;
  const member = context.items.find((row) => row.id === memberId);
  if (!profile.can_manage || !member || member.role === "owner" ||
      member.id === chat.me.value?.id || (!profile.is_owner &&
        (member.role === "admin" || action === "role" || action === "transfer"))) {
    throw Error("成员权限已变化，请刷新成员列表后再试");
  }
  const target = { conversation_id: conversationId, user_id: memberId };
  switch (action) {
    case "role":
      await chat.post("/conversations/members/role", {
        ...target, role: member.role === "admin" ? "member" : "admin",
      });
      break;
    case "mute": {
      const input = member.is_muted ? "0" : prompt("禁言分钟数，-1 为永久禁言", "10");
      if (input === null) return false;
      const minutes = Number(input);
      if (!input.trim() || !Number.isSafeInteger(minutes) || minutes < -1 ||
          (!member.is_muted && minutes === 0)) throw Error("请输入有效的禁言分钟数");
      await chat.post("/conversations/members/mute", { ...target, minutes });
      break;
    }
    case "remove":
      if (!confirm("从群组移除此成员？")) return false;
      await chat.post("/conversations/members/remove", target);
      break;
    case "transfer":
      if (!confirm("转让群主给此成员？")) return false;
      await chat.post("/conversations/groups/transfer", target);
      break;
  }
  return true;
}
