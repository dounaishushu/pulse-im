<script setup lang="ts">
import {
  computed,
  inject,
  onScopeDispose,
  shallowRef,
  reactive,
  watch,
  useId,
} from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import GroupMemberMenu from "./GroupMemberMenu.vue";
import { canViewGroupMember, sortGroupMembers } from "./memberPresentation";
import { isMemberSocialAction, manageGroupMember, type MemberAction, type MemberSocialAction } from "./memberActions";
import { chatKey } from "../../composables/useChat";

import type {
  Conversation,
  Group,
  Member,
  Page,
  Profile,
} from "../../api/types";
const props = defineProps<{
  mode: "group" | "create-channel" | "join";
  inline?: boolean;
  initialSection?: "profile" | "members" | "manage";
  openInvite?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  updated: [];
  invite: [];
  member: [action: MemberSocialAction, member: Member];
}>();
const chat = inject(chatKey)!;
const client = chat.client;
const navigator = window.navigator;
const group = shallowRef<Group | null>(null),
  name = shallowRef(""),
  description = shallowRef(""),
  announcement = shallowRef(""),
  code = shallowRef(""),
  number = shallowRef(""),
  joinChannel = shallowRef(false),
  blockFriends = shallowRef(false),
  joinPolicy = shallowRef<"open" | "invite" | "closed">("invite"),
  allMuted = shallowRef(false),
  memberInvites = shallowRef(false),
  allowHistory = shallowRef(false);
const members = shallowRef<Member[]>([]),
  candidates = shallowRef<Profile[]>([]),
  selected = shallowRef<number[]>([]),
  query = shallowRef(""),
  page = shallowRef(1),
  hasMore = shallowRef(false),
  busy = shallowRef(false),
  inviteMode = shallowRef(false),
  avatar = shallowRef<File | undefined>();
const candidatePage = shallowRef(1),
  candidateMore = shallowRef(false),
  candidateQuery = shallowRef(""),
  candidateLoading = shallowRef(false),
  candidateError = shallowRef("");
const queries = reactive({ pinned: "", recent: "" });
const candidateVisible = computed(() => {
  const people = new Map(candidates.value.map((row) => [row.id, row]));
  const time = (user: number) =>
    chat.conversations.value.find((row) => row.peer_user_id === user)
      ?.updated_at || "";
  return [...people.values()]
    .filter(
      (row) =>
        row.id !== chat.me.value?.id &&
        (!candidateQuery.value ||
          [row.nickname, row.username, row.remark, row.public_id]
            .join(" ")
            .toLowerCase()
            .includes(candidateQuery.value.toLowerCase())),
    )
    .sort((a, b) => time(b.id).localeCompare(time(a.id)) || a.id - b.id);
});
const pinnedIds = computed(
  () =>
    new Set(
      chat.conversations.value
        .filter((row) => row.type === "direct" && row.is_pinned)
        .map((row) => row.peer_user_id),
    ),
);
const candidateSections = computed(() =>
  [
    {
      kind: "pinned" as const,
      name: "置顶用户列表",
      items: candidateVisible.value.filter((row) =>
        pinnedIds.value.has(row.id),
      ),
    },
    {
      kind: "recent" as const,
      name: "最新消息用户列表",
      items: candidateVisible.value.filter(
        (row) => !pinnedIds.value.has(row.id),
      ),
    },
  ].map((section) => ({
    ...section,
    items: section.items.filter((row) =>
      [row.nickname, row.username, row.remark, row.public_id]
        .join(" ")
        .toLowerCase()
        .includes(queries[section.kind].toLowerCase()),
    ),
  })),
);
const capacity = computed(() =>
  Math.max(
    0,
    (group.value?.member_limit ||
      chat.config.value?.group_member_limit ||
      500) - (group.value?.member_count || 1),
  ),
);
function selectSection(rows: Profile[]) {
  const ids = new Set(selected.value);
  if (rows.length && rows.every((row) => ids.has(row.id)))
    for (const row of rows) ids.delete(row.id);
  else
    for (const row of rows) {
      if (ids.size >= capacity.value) break;
      ids.add(row.id);
    }
  selected.value = [...ids];
}
let uploadedAvatar = "";
const avatarPreview = shallowRef("");
watch(avatar, file => {
  uploadedAvatar = "";
  if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value);
  avatarPreview.value = file ? URL.createObjectURL(file) : "";
});
let disposed = false;
let profileController: AbortController | undefined;
let memberController: AbortController | undefined;
const detailsError = shallowRef("");
const membersError = shallowRef("");
const membersLoading = shallowRef(false);
const tabId = useId();
const groupTabs = [
  { id: "profile", label: "群资料" },
  { id: "members", label: "群成员" },
  { id: "manage", label: "群管理" },
] as const;
const section = shallowRef<(typeof groupTabs)[number]["id"]>(props.initialSection || "profile");
type SettingsView = "overview" | "type" | "announcement" | "permissions" | "exceptions" | "links" | "admins" | "members" | "personal";
const settingsView = shallowRef<SettingsView>("overview");
const settingsError = shallowRef("");
const confirmAction = shallowRef<"invite-code" | "leave" | "dissolve" | null>(null);
const administratorCount = shallowRef<number>();
const managing = computed(() => props.mode === "group" && section.value === "manage");
const settingsTitles: Record<SettingsView, string> = { overview: "编辑群组", type: "群组类型", announcement: "群公告", permissions: "权限", exceptions: "权限例外", links: "邀请链接", admins: "管理员", members: "成员", personal: "个人设置" };
const joinPolicyLabels = { open: "公开加入", invite: "邀请加入", closed: "禁止自主加入" };
const sendingAllowed = computed({ get: () => group.value?.type !== "channel" && !allMuted.value, set: (allowed: boolean) => { allMuted.value = !allowed; } });
const addingException = shallowRef(false);
const exceptionMember = shallowRef<Member | null>(null);
const exceptionMinutes = shallowRef(10);
const settingsMembers = computed(() => settingsView.value === "admins" && !query.value.trim()
  ? members.value.filter(row => row.role !== "member") : settingsView.value === "exceptions"
    ? members.value.filter(row => row.role === "member" && row.id !== chat.me.value?.id) : members.value);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, () => {
  clearTimeout(searchTimer);
  if (!managing.value || !["admins", "members", "exceptions"].includes(settingsView.value)) return;
  memberController?.abort();
  members.value = []; hasMore.value = false;
  membersLoading.value = true;
  searchTimer = setTimeout(() => { void loadMembers(); }, 300);
}, { flush: "sync" });
function settingsPage(view: SettingsView) {
  settingsView.value = view;
  confirmAction.value = null;
  settingsError.value = "";
  exceptionMember.value = null; addingException.value = false;
  if (["members", "admins", "exceptions"].includes(view)) { query.value = ""; void loadMembers(); }
}
function exceptionMode(adding: boolean) {
  addingException.value = adding; exceptionMember.value = null;
  query.value = ""; void loadMembers();
}
async function saveException() {
  const member = exceptionMember.value;
  if (!member) return;
  await runMemberAction("mute", member, { minutes: Number(exceptionMinutes.value) });
  if (!settingsError.value) { exceptionMember.value = null; addingException.value = false; void loadMembers(); }
}
function chooseAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) {
    settingsError.value = "请选择不超过 10 MB 的图片";
    (event.target as HTMLInputElement).value = "";
    return;
  }
  avatar.value = file;
}
async function personalSetting(key: "notifications_muted" | "is_pinned") {
  if (busy.value || !id || !group.value) return;
  busy.value = true;
  settingsError.value = "";
  try {
    const result = await chat.post<Group>("/conversations/groups/settings", { conversation_id: id, [key]: !group.value[key] });
    if (disposed) return;
    group.value = result;
    emit("updated");
    await chat.loadDirectory();
  } catch (cause) { if (!disposed) settingsError.value = cause instanceof Error ? cause.message : "设置未保存，请重试"; }
  finally { busy.value = false; }
}
const visibleTabs = computed(() => groupTabs.filter(tab => tab.id !== "manage" || group.value?.can_manage));
watch(section, value => {
  if ((value === "members" || value === "manage") && !members.value.length) void loadMembers();
});
function changeTab(event: KeyboardEvent) {
  const buttons = Array.from((event.currentTarget as HTMLElement).querySelectorAll("button"));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
    (index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
  buttons[next]?.focus();
  buttons[next]?.click();
}
function canViewMember(member: Member) {
  return canViewGroupMember(group.value, member.id, chat.me.value?.id);
}
async function runMemberAction(action: MemberAction, member: Member, options: { role?: "member" | "admin"; minutes?: number } = {}) {
  if (isMemberSocialAction(action)) {
    emit("member", action, member);
    return;
  }
  if (!id || busy.value) return;
  busy.value = true;
  settingsError.value = "";
  try {
    const intent = action === "mute" && options.minutes == null
      ? { ...options, minutes: member.is_muted ? 0 : -1 } : options;
    if (await manageGroupMember(chat, id, member.id, action, intent)) {
      emit("updated");
      await Promise.all([load(true), loadMembers(), chat.loadDirectory()]);
    }
  } catch (cause) {
    if (!disposed) {
      settingsError.value = cause instanceof Error ? cause.message : "成员设置失败，请重试";
      if (!managing.value || [401, 426].includes((cause as { status?: number }).status ?? 0)) chat.error(cause);
    }
  } finally {
    busy.value = false;
  }
}
const id = chat.active.value?.id;
const title = computed(() =>
  props.mode === "join"
    ? "加入群组 / 频道"
    : props.mode === "create-channel"
      ? "新建频道"
      : managing.value ? settingsTitles[settingsView.value] : "群组资料与成员管理",
);
async function load(preserveDraft = false) {
  if (props.mode !== "group" || !id) return;
  profileController?.abort();
  const request = profileController = new AbortController();
  detailsError.value = "";
  try {
    const info = await chat.api<Group>(
      "/conversations/groups/profile?conversation_id=" + id,
      { signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]), deferMedia: true },
    );
    if (disposed || request !== profileController) return;
    group.value = info;
    if (typeof info.administrator_count === "number") administratorCount.value = info.administrator_count;
    if (info.invite_code) code.value = info.invite_code;
    if (!preserveDraft) {
    name.value = info.name;
    description.value = info.description || "";
    announcement.value = info.announcement || "";
    blockFriends.value = info.allow_member_add_friend === false;
    joinPolicy.value = info.join_policy || "invite";
    allMuted.value = info.all_muted === true;
    memberInvites.value = info.allow_member_invites === true;
    }
    if (!info.can_manage && section.value === "manage") section.value = "profile";
  } catch (cause) {
    if (disposed || request !== profileController) return;
    if ([401, 426].includes((cause as { status?: number }).status ?? 0)) chat.error(cause);
    else detailsError.value = "群资料加载失败";
  }
}
async function loadMembers(append = false) {
  clearTimeout(searchTimer);
  if (!id || props.mode !== "group") return;
  memberController?.abort();
  const request = memberController = new AbortController();
  membersLoading.value = true;
  membersError.value = "";
  const next = append ? page.value + 1 : 1;
  if (!append) {
    members.value = [];
    hasMore.value = false;
  }
  try {
    const roster = await chat.api<Page<Member> & { members_visibility: string }>("/conversations/members?" +
      new URLSearchParams({ conversation_id: String(id), q: query.value.trim(), page: String(next), ...(settingsView.value === "exceptions" && !addingException.value ? { restriction: "muted" } : {}) }),
      { signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]), deferMedia: true });
    if (disposed || request !== memberController) return;
    members.value = sortGroupMembers(append ? [...members.value, ...roster.items] : roster.items);
    hasMore.value = roster.has_more === true;
    page.value = next;
    if (settingsView.value !== "exceptions" && !query.value.trim() && !roster.has_more) administratorCount.value = members.value.filter(row => row.role === "admin").length;
    if (settingsView.value !== "exceptions" && !append && roster.has_more && !query.value.trim()) {
      const managers = await chat.api<Page<Member> & { managers_only: boolean; viewer_role: string; members_visibility: string }>(
        `/conversations/members?conversation_id=${id}&roles=managers`,
        { signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]), deferMedia: true });
      if (disposed || request !== memberController) return;
      if (managers.members_visibility !== roster.members_visibility || managers.viewer_role !== group.value?.my_role) {
        members.value = []; hasMore.value = false;
        throw Error("成员权限已变化，请刷新成员列表");
      }
      if (managers.managers_only !== true || managers.has_more !== false ||
        managers.items.some(row => !["owner", "admin"].includes(row.role))) throw Error("成员权限已变化，请刷新成员列表");
      members.value = sortGroupMembers([...members.value, ...managers.items]);
      administratorCount.value = managers.items.filter(row => row.role === "admin").length;
    }
  } catch (cause) {
    if (disposed || request !== memberController || request.signal.aborted) return;
    if ([401, 426].includes((cause as { status?: number }).status ?? 0)) chat.error(cause);
    else membersError.value = "成员加载失败";
  } finally {
    if (request === memberController) membersLoading.value = false;
  }
}
async function choices(append = false) {
  if (candidateLoading.value) return;
  candidateLoading.value = true;
  candidateError.value = "";
  if (!append) candidatePage.value = 1;
  try {
    const result =
      props.mode === "group" && id
        ? await chat.api<Page<Profile>>(
            `/conversations/invite-candidates?conversation_id=${id}&q=${encodeURIComponent(candidateQuery.value)}&page=${candidatePage.value}&size=100`,
          )
        : await chat.api<Page<Profile>>(
            "/contacts?size=100&page=" + candidatePage.value,
          );
    if (!disposed) {
      candidates.value = append
        ? [...candidates.value, ...result.items]
        : result.items;
      candidateMore.value =
        result.has_more === true ||
        (result.items.length === 100 &&
          (result.total == null || candidates.value.length < result.total));
    }
  } catch (cause) {
    if (!disposed)
      candidateError.value =
        cause instanceof Error ? cause.message : "用户列表加载失败";
  } finally {
    candidateLoading.value = false;
  }
}
async function save() {
  if (props.mode === "group" && (!group.value?.can_manage || !name.value.trim())) {
    settingsError.value = "请填写群组名称";
    return;
  }
  settingsError.value = "";
  if (busy.value) return;
  busy.value = true;
  try {
    let avatarUrl = "";
    if (avatar.value) {
      if (!uploadedAvatar)
        uploadedAvatar = (
          await client.uploadMedia(
            "avatar",
            avatar.value,
          )
        ).url;
      avatarUrl = uploadedAvatar;
    }
    if (props.mode === "join") {
      const row = await chat.post<Conversation>(
        joinChannel.value
          ? "/conversations/channels/follow"
          : "/conversations/groups/join",
        {
          ...(code.value ? { invite_code: code.value } : {}),
          ...(number.value
            ? {
                group_number: number.value,
                ...(joinChannel.value ? { conversation_id: number.value } : {}),
              }
            : {}),
        },
      );
      await chat.loadDirectory();
      await chat.choose(row.id);
      emit("close");
    } else if (props.mode.startsWith("create")) {
      const row = await chat.post<Conversation & { profile_update_pending?: boolean }>(
        props.mode === "create-channel"
          ? "/conversations/channels"
          : "/conversations/groups",
        {
          name: name.value.trim(),
          description: description.value.trim(),
          member_ids: selected.value,
          allow_member_add_friend: !blockFriends.value,
          ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
        },
      );
      await chat.loadDirectory();
      await chat.choose(row.id);
      emit("close");
      if (row.profile_update_pending) {
        chat.error(new Error("频道已创建，简介或头像未能保存。可以在频道资料中重新保存。"));
      }
    } else {
      await chat.post("/conversations/groups/profile", {
        conversation_id: id,
        ...(name.value !== group.value?.name ? { name: name.value.trim() } : {}),
        ...(description.value !== (group.value?.description || "") ? { description: description.value } : {}),
        ...(announcement.value !== (group.value?.announcement || "") ? { announcement: announcement.value } : {}),
        ...(joinPolicy.value !== group.value?.join_policy ? { join_policy: joinPolicy.value } : {}),
        ...(!blockFriends.value !== group.value?.allow_member_add_friend ? { allow_member_add_friend: !blockFriends.value } : {}),
        ...(allMuted.value !== (group.value?.all_muted === true) ? { all_muted: allMuted.value } : {}),
        ...(memberInvites.value !== (group.value?.allow_member_invites === true) ? { allow_member_invites: memberInvites.value } : {}),
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      });
      emit("updated");
      await chat.refresh();
      emit("close");
    }
  } catch (cause) {
    if (managing.value) settingsError.value = cause instanceof Error ? cause.message : "资料未保存，请重试";
    else chat.error(cause);
  } finally {
    busy.value = false;
  }
}
async function manage(action: "all-muted" | "invite-code" | "invite" | "leave" | "dissolve", confirmed = false) {
  if (!id || busy.value) return;
  busy.value = true;
  try {
    const base = { conversation_id: id };
    if (action === "all-muted")
      await chat.post("/conversations/groups/settings", {
        ...base,
        all_muted: !group.value?.all_muted,
      });
    if (
      action === "invite-code" &&
      (confirmed || confirm("生成新的邀请码会使旧码失效，继续？"))
    ) {
      const result = await chat.post<{ invite_code: string }>(
        "/go/invite-code",
        base,
      );
      code.value = result.invite_code;
    }
    if (action === "invite") {
      const result: {
        items: { user_id: number; status: string; message?: string }[];
      } = { items: [] };
      const targets = [...selected.value];
      for (let start = 0; start < targets.length; start += 50) {
        const part = await chat.post<typeof result>(
          "/conversations/members/batch",
          {
            ...base,
            user_ids: targets.slice(start, start + 50),
            allow_history: allowHistory.value,
          },
        );
        if (disposed) return;
        result.items.push(...part.items);
        selected.value = selected.value.filter(
          (user) =>
            !part.items.some(
              (row) => row.user_id === user && row.status === "joined",
            ),
        );
      }
      const rejected = result.items.filter((item) => item.status !== "joined");
      if (rejected.length)
        chat.error(
          Error(
            rejected.map((item) => item.message || "邀请被拒绝").join("；"),
          ),
        );
      selected.value = rejected.map((item) => item.user_id);
      inviteMode.value = rejected.length > 0;
    }
    if (
      (action === "leave" || action === "dissolve") &&
      (confirmed || confirm(action === "leave" ? "退出此群？" : "解散此群？"))
    ) {
      await chat.post(
        action === "leave"
          ? "/conversations/leave"
          : "/conversations/groups/dissolve",
        base,
      );
      chat.active.value = null;
      chat.messages.value = [];
      emit("close");
    }
    if (disposed) return;
    if (action === "invite") {
      emit("updated");
      void loadMembers();
    }
    confirmAction.value = null;
    if (action !== "invite-code" && action !== "leave" && action !== "dissolve") await load(true);
    await chat.loadDirectory();
  } catch (cause) {
    if (managing.value) settingsError.value = cause instanceof Error ? cause.message : "操作未完成，请重试";
    else chat.error(cause);
  } finally {
    busy.value = false;
  }
}
function roleLabel(role?: string) {
  switch (role) {
    case "owner":
      return "群主";
    case "admin":
      return "管理员";
    case "member":
      return "成员";
    default:
      return role || "";
  }
}
if (props.mode === "group") {
  void load().then(() => {
    if (disposed || !group.value) return;
    if (section.value === "members" || section.value === "manage") void loadMembers();
    if (props.openInvite && group.value.can_invite) {
      inviteMode.value = true;
      void choices();
    }
  });
}
onScopeDispose(() => {
  disposed = true;
  clearTimeout(searchTimer);
  if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value);
  profileController?.abort();
  memberController?.abort();
});
</script>
<template>
  <BaseDialog
    :title="title"
    :size="!managing && mode === 'group' ? 'wide' : 'compact'"
    :layout="managing ? 'group-management' : undefined"
    :busy="busy"
    :inline="inline"
    @close="emit('close')"
  >
    <p v-if="mode === 'group' && !group && !detailsError" role="status">正在加载群资料…</p>
    <p v-if="detailsError" role="alert">{{ detailsError }} <button @click="load()">重试</button></p>
    <template v-if="mode === 'group' && group">
      <nav v-if="!managing" class="group-tabs" role="tablist" aria-label="群组面板"
        @keydown.left.prevent="changeTab" @keydown.right.prevent="changeTab"
        @keydown.home.prevent="changeTab" @keydown.end.prevent="changeTab">
        <button v-for="tab in visibleTabs" :key="tab.id" :id="tabId + '-tab-' + tab.id"
          type="button" role="tab" :aria-selected="section === tab.id"
          :tabindex="section === tab.id ? 0 : -1" :aria-controls="tabId + '-' + tab.id"
          @click="section = tab.id">{{ tab.label }}</button>
      </nav>
      <section v-show="section === 'profile'" role="tabpanel" :id="tabId + '-profile'" :aria-labelledby="tabId + '-tab-profile'">
    <header class="group-summary">
      <AvatarImage :name="group.name" :src="group.avatar_url" :media-id="group.avatar_id" />
      <div class="min-w-0">
        <h3>{{ group.name }}</h3>
        <p v-if="group.member_count != null || group.my_role">
          <span v-if="group.member_count != null"
            >{{ group.member_count }} 位成员</span
          ><span v-if="group.my_role"
            >{{ group.member_count != null ? " · " : ""
            }}{{ roleLabel(group.my_role) }}</span
          >
        </p>
        <p>群号：{{ group.group_number || group.invite_code || "暂不可用" }}</p>
      </div>
    </header>

      <div class="vue-action-list group-actions">
        <button
          @click="
            chat
              .mutate('/conversations/groups/settings', {
                conversation_id: id,
                is_pinned: !group.is_pinned,
              })
              .then(() => load())
              .catch(chat.error)
          "
        >
          <UiIcon name="bookmark" />
          {{ group.is_pinned ? "取消置顶" : "置顶会话" }}</button
        ><button
          @click="
            navigator.clipboard
              .writeText(group.group_number || group.invite_code || '')
              .catch(chat.error)
          "
        >
          <UiIcon name="link" /> 复制群号
        </button>
        <button
          role="switch"
          aria-label="群通知"
          :aria-checked="!group.notifications_muted"
          @click="
            chat
              .mutate('/conversations/groups/settings', {
                conversation_id: id,
                notifications_muted: !group.notifications_muted,
              })
              .then(() => load())
              .catch(chat.error)
          "
        >
          <span>{{
            group.notifications_muted ? "通知已关闭" : "通知已开启"
          }}</span>
          <span class="ui-switch-visual" aria-hidden="true"></span></button
        >
        <button v-if="!group.is_owner" class="vue-button-danger" @click="manage('leave')">退出群组</button>
      </div>
        <dl class="group-profile-copy">
          <template v-if="group.description"><dt>简介</dt><dd>{{ group.description }}</dd></template>
          <template v-if="group.announcement"><dt>公告</dt><dd>{{ group.announcement }}</dd></template>
        </dl>
      </section>
      <section v-show="section === 'members'" role="tabpanel" :id="tabId + '-members'" :aria-labelledby="tabId + '-tab-members'">
      <div class="group-members-section">
        <button v-if="group.can_invite" type="button" @click="emit('invite')">邀请入群</button>
      <form class="vue-panel-search" @submit.prevent="loadMembers()">
        <input
          v-model="query"
          aria-label="搜索群成员"
          placeholder="搜索群成员"
        /><button type="submit"><UiIcon name="search" /> 搜索</button>
      </form>
      <p v-if="membersError" role="alert">{{ membersError }} <button @click="loadMembers()">重试</button></p>
      <p v-else-if="membersLoading && !members.length" role="status">正在加载成员…</p>
      <p v-else-if="!members.length">没有匹配的成员</p>
      <article
        v-for="member in members"
        :key="member.id"
        class="vue-contact-row vue-group-member"
      >
        <AvatarImage :name="member.nickname" :src="member.avatar_url" :media-id="member.avatar_id" /><span
          class="vue-group-person"
          ><button
            type="button"
            :disabled="!canViewMember(member)"
            @click="runMemberAction('profile', member)"
          >
            {{ member.nickname }}
          </button>
          <small
            >{{ roleLabel(member.role)
            }}{{ member.is_muted ? " · 已禁言" : "" }}</small
          ></span
        >
        <GroupMemberMenu
          :member="member"
          :owner="group.is_owner === true"
          :can-manage="group.can_manage === true"
          :can-profile="canViewMember(member)"
          :can-add="group.allow_member_add_friend === true"
          :self="member.id === chat.me.value?.id"
          :busy="busy"
          @action="runMemberAction($event, member)"
        />
      </article>
      <button
        v-if="hasMore"
        :disabled="membersLoading"
        @click="loadMembers(true)"
      >
        加载更多成员
      </button>
      </div>

      </section>
      <section v-if="group.can_manage && managing" class="group-edit" :aria-busy="busy">
        <p v-if="settingsError" class="group-edit-error" role="alert">{{ settingsError }}</p>
        <template v-if="settingsView === 'overview'">
          <div class="group-edit-identity">
            <label class="group-edit-avatar" :class="{ disabled: busy }" title="更换群头像">
              <AvatarImage :name="name" :src="avatarPreview || group.avatar_url" :media-id="avatarPreview ? undefined : group.avatar_id" />
              <span class="group-edit-camera"><UiIcon name="camera" /></span>
              <input type="file" accept="image/*" aria-label="更换群头像" :disabled="busy" @change="chooseAvatar" />
            </label>
            <label class="group-edit-name">群组名称<input v-model="name" aria-label="群组名称" maxlength="128" :disabled="busy" required /></label>
          </div>
          <textarea v-model="description" class="group-edit-description" aria-label="群简介" placeholder="简介（可选）" maxlength="500" :disabled="busy" rows="2"></textarea>
          <div class="group-edit-section">
            <button type="button" class="group-edit-row" :disabled="busy" @click="settingsPage('type')"><UiIcon name="settings" /><span>群组类型</span><small>{{ joinPolicyLabels[joinPolicy] }}</small></button>
            <button type="button" class="group-edit-row" :disabled="busy" @click="settingsPage('announcement')"><UiIcon name="chat" /><span>群公告</span><small>{{ announcement.trim() ? '已设置' : '未设置' }}</small></button>
          </div>
          <div class="group-edit-section">
            <button type="button" class="group-edit-row" :disabled="busy" @click="settingsPage('permissions')"><UiIcon name="lock" /><span>权限</span><small>{{ allMuted ? '全员禁言' : blockFriends ? '禁止互加好友' : '已开放' }}</small></button>
            <button type="button" class="group-edit-row" :disabled="busy" @click="settingsPage('links')"><UiIcon name="link" /><span>邀请链接</span><small>{{ code ? '已生成邀请码' : '管理' }}</small></button>
            <button type="button" class="group-edit-row" :disabled="busy" @click="settingsPage('admins')"><UiIcon name="shield" /><span>管理员</span><small>{{ administratorCount ?? (membersError ? '重试' : '加载中…') }}</small></button>
            <button type="button" class="group-edit-row" :disabled="busy" @click="settingsPage('members')"><UiIcon name="group" /><span>成员</span><small>{{ group.member_count ?? '查看' }}</small></button>
          </div>
          <div class="group-edit-section"><button type="button" class="group-edit-row" :disabled="busy" @click="settingsPage('personal')"><UiIcon name="bell" /><span>个人设置</span></button></div>
        </template>
        <template v-else>
          <div class="group-edit-detail">
            <p v-if="settingsView === 'type' || settingsView === 'announcement' || settingsView === 'permissions'" class="group-edit-help">完成后返回编辑群组，点击“保存”生效。</p>
            <template v-if="settingsView === 'type'">
              <label v-for="(label, value) in joinPolicyLabels" :key="value" class="group-edit-option"><input v-model="joinPolicy" type="radio" name="group-join-policy" :value="value" :disabled="busy" /><span>{{ label }}<small>{{ value === 'open' ? '允许用户通过群号加入' : value === 'invite' ? '通过有效邀请码加入' : '关闭群号及邀请码自主加入' }}</small></span></label>
            </template>
            <label v-if="settingsView === 'announcement'" class="group-edit-field">群公告<textarea v-model="announcement" aria-label="群公告内容" maxlength="10000" :disabled="busy" rows="9" placeholder="填写群公告"></textarea><small>{{ announcement.length }} / 10000</small></label>
            <template v-if="settingsView === 'permissions'">
              <h3 class="group-permission-heading">这个群组的成员可以做什么？</h3>
              <label class="group-permission-option" title="关闭后全员禁言，群主及管理员仍可发言。"><span>发送消息</span><input v-model="sendingAllowed" class="group-permission-switch" type="checkbox" :disabled="busy || group.type === 'channel'" role="switch" aria-label="发送消息" /></label>
              <label class="group-permission-option" title="开启后，普通群员不能从群内查看其他成员资料或互加好友。"><span>禁止群成员互加好友</span><input v-model="blockFriends" class="group-permission-switch" type="checkbox" :disabled="busy" role="switch" aria-label="禁止群成员互加好友" /></label>
              <label class="group-permission-option" title="允许普通群员从聊天的“更多操作”邀请新成员。"><span>邀请新成员</span><input v-model="memberInvites" class="group-permission-switch" type="checkbox" :disabled="busy || group.type !== 'group' || typeof group.allow_member_invites !== 'boolean'" role="switch" aria-label="允许普通群员邀请新成员" /></label>
              <div class="group-permission-option"><span>置顶消息</span><span class="group-permission-locked" role="img" aria-label="置顶消息仅限群主及管理员"><UiIcon name="lock" /></span></div>
              <div class="group-permission-option"><span>修改群组信息</span><span class="group-permission-locked" role="img" aria-label="修改群组信息仅限群主及管理员"><UiIcon name="lock" /></span></div>
              <p class="group-permission-note">置顶消息和修改群组信息仅允许群主及管理员操作。</p>
              <p v-if="typeof group.allow_member_invites !== 'boolean'" class="group-edit-help" role="status">服务器更新后可设置普通群员的邀请权限。</p>
              <button type="button" class="group-edit-row group-permission-exceptions" :disabled="busy || typeof group.restricted_member_count !== 'number'" @click="settingsPage('exceptions')"><UiIcon name="key" /><span>例外</span><small>{{ group.restricted_member_count ?? '需更新服务器' }}</small></button>
            </template>
            <template v-if="settingsView === 'links'">
              <p class="group-edit-help">当前程序通过群号或邀请码入群。重新生成邀请码会立即使旧码失效。</p>
              <label v-if="group.group_number" class="group-edit-field">群号<input :value="group.group_number" readonly /><button type="button" :disabled="busy" @click="navigator.clipboard.writeText(group.group_number).catch(chat.error)">复制群号</button></label>
              <label v-if="code" class="group-edit-field">邀请码<input :value="code" readonly aria-label="群邀请码" /><button type="button" :disabled="busy" @click="navigator.clipboard.writeText(code).catch(chat.error)">复制邀请码</button></label>
              <p v-else class="group-edit-help">出于安全考虑，服务器不返回历史邀请码；可生成新码后复制给受邀用户。</p>
              <button v-if="confirmAction !== 'invite-code'" type="button" :disabled="busy" @click="confirmAction = 'invite-code'">生成新邀请码</button>
              <div v-else class="group-edit-confirm" role="alert"><p>旧邀请码将立即失效，确认生成新码？</p><button type="button" :disabled="busy" @click="confirmAction = null">取消生成</button><button type="button" :disabled="busy" @click="manage('invite-code', true)">确认生成</button></div>
            </template>
            <template v-if="settingsView === 'members' || settingsView === 'admins' || settingsView === 'exceptions'">
              <p v-if="settingsView === 'admins'" class="group-edit-help">{{ group.is_owner ? '搜索群成员的备注、昵称、账号或 ID，可直接设置或取消管理员。任免立即生效。' : '可以搜索群成员，只有群主可以任免管理员。' }}</p>
              <button v-if="settingsView === 'members' && group.can_invite" type="button" :disabled="busy" @click="emit('invite')"><UiIcon name="userAdd" />邀请入群</button>
              <template v-if="settingsView === 'exceptions'">
                <p class="group-edit-help">例外为单独禁言的普通成员，修改立即生效。全员禁言开启时，解除单独禁言仍需遵守全员禁言。</p>
                <button type="button" :disabled="busy" @click="exceptionMode(!addingException)">{{ addingException ? '返回例外名单' : '添加例外' }}</button>
                <form v-if="exceptionMember" class="group-exception-form" @submit.prevent="saveException"><strong>{{ chat.contactName(exceptionMember.id, exceptionMember.nickname) }}</strong><label>禁言分钟数<input v-model.number="exceptionMinutes" type="number" min="-1" max="43200" required aria-label="禁言分钟数" /></label><small>-1 为永久，1 至 43200 为分钟数。</small><button type="button" :disabled="busy" @click="exceptionMember = null">取消设置</button><button type="submit" :disabled="busy || exceptionMinutes === 0">保存例外</button></form>
              </template>
              <form class="vue-panel-search" @submit.prevent="loadMembers()"><input v-model="query" aria-label="搜索管理成员" placeholder="搜索备注/昵称/账号/ID" maxlength="100" /><button type="submit" :disabled="membersLoading"><UiIcon name="search" /></button></form>
              <p v-if="membersError" role="alert">{{ membersError }} <button type="button" @click="loadMembers()">重试</button></p>
              <p v-else-if="membersLoading && !settingsMembers.length" role="status">正在加载成员…</p>
              <p v-else-if="!settingsMembers.length" class="group-edit-help">没有匹配的成员</p>
              <article v-for="member in settingsMembers" :key="member.id" class="group-edit-member">
                <AvatarImage :name="member.nickname" :src="member.avatar_url" :media-id="member.avatar_id" />
                <span class="group-edit-person"><strong>{{ chat.contactName(member.id, member.nickname) }}</strong><small>{{ roleLabel(member.role) }}{{ member.is_muted ? ' · 已禁言' : '' }}</small></span>
                <button v-if="settingsView === 'admins' && group.is_owner && member.role !== 'owner' && member.id !== chat.me.value?.id" type="button" class="ui-text-button group-admin-action" :disabled="busy || membersLoading" @click="runMemberAction('role', member, { role: member.role === 'admin' ? 'member' : 'admin' })">{{ member.role === 'admin' ? '取消管理员' : '设为管理员' }}</button>
                <button v-if="settingsView === 'exceptions'" type="button" class="ui-text-button" :disabled="busy || membersLoading" @click="member.is_muted ? runMemberAction('mute', member, { minutes: 0 }) : (exceptionMember = member, exceptionMinutes = 10)">{{ member.is_muted ? '解除禁言' : '设置禁言' }}</button>
                <GroupMemberMenu :member="member" :owner="group.is_owner === true" :can-manage="group.can_manage === true" :can-profile="canViewMember(member)" :can-add="group.allow_member_add_friend === true" :self="member.id === chat.me.value?.id" :busy="busy" @action="runMemberAction($event, member)" />
              </article>
              <button v-if="hasMore" type="button" :disabled="membersLoading || busy" @click="loadMembers(true)">加载更多成员</button>
            </template>
            <template v-if="settingsView === 'personal'">
              <p class="group-edit-help">以下设置立即生效，仅影响当前账号。</p>
              <button type="button" class="group-edit-row" role="switch" :aria-checked="group.notifications_muted === true" :disabled="busy" @click="personalSetting('notifications_muted')"><UiIcon name="bell" /><span>消息免打扰</span><small>{{ group.notifications_muted ? '已开启' : '已关闭' }}</small></button>
              <button type="button" class="group-edit-row" role="switch" :aria-checked="group.is_pinned === true" :disabled="busy" @click="personalSetting('is_pinned')"><UiIcon name="pin" /><span>置顶会话</span><small>{{ group.is_pinned ? '已置顶' : '未置顶' }}</small></button>
              <button v-if="group.is_owner" type="button" class="vue-button-danger group-edit-destructive" :disabled="busy" @click="confirmAction = 'dissolve'">解散群组</button>
              <button v-else type="button" class="vue-button-danger group-edit-destructive" :disabled="busy" @click="confirmAction = 'leave'">退出群组</button>
              <div v-if="confirmAction === 'leave' || confirmAction === 'dissolve'" class="group-edit-confirm" role="alert"><p>{{ confirmAction === 'dissolve' ? '解散后所有群成员都会退出，此操作不可恢复。' : '确认退出此群组？' }}</p><button type="button" :disabled="busy" @click="confirmAction = null">取消操作</button><button type="button" class="vue-button-danger" :disabled="busy" @click="manage(confirmAction, true)">{{ confirmAction === 'dissolve' ? '确认解散' : '确认退出' }}</button></div>
            </template>
          </div>
        </template>
      </section>
    </template>
    <form
      v-if="mode !== 'group'"
      class="vue-fields"
      @submit.prevent="save"
    >
      <template v-if="mode === 'join'"
        ><label><input v-model="joinChannel" type="checkbox" />加入频道</label
        ><label>邀请码<input v-model="code" /></label
        ><label>群号或频道编号<input v-model="number" /></label
      ></template>
      <template v-else
        ><label
          >名称<input
            v-model="name"
            required
            maxlength="128"
            :disabled="busy" /></label
        ><label
          >头像<input
            type="file"
            :disabled="busy"
            accept="image/*"
            @change="
              avatar = ($event.target as HTMLInputElement).files?.[0]
            " /></label
        ><label v-if="mode === 'create-channel'"
          >简介<textarea
            v-model="description"
            maxlength="500"
          ></textarea></label
        ></template>
      <button class="primary" :disabled="busy">
        {{ mode === "join" ? "加入" : "创建" }}
      </button>
    </form>

    <section
      v-if="inviteMode && group?.can_invite"
      v-show="section === 'members'"
      class="vue-group-candidates"
    >
      <h3>选择好友</h3>
      <p v-if="candidateLoading" role="status">正在加载用户…</p>
      <p v-if="candidateError" role="alert">
        {{ candidateError }}<button @click="choices()">重试</button>
      </p>
      <form class="vue-panel-search" @submit.prevent="choices()">
        <input
          v-model="candidateQuery"
          aria-label="搜索可邀请好友"
          placeholder="搜索好友"
        /><button>搜索</button>
      </form>
      <button
        type="button"
        @click="
          selected = candidateVisible.slice(0, capacity).map((item) => item.id)
        "
      >
        全选</button
      ><button type="button" @click="selected = []">清空</button>
      <section v-for="section in candidateSections" :key="section.name">
        <h4>{{ section.name }}</h4>
        <input
          v-model="queries[section.kind]"
          :aria-label="'搜索' + section.name"
          placeholder="搜索昵称 / 用户名 / ID"
        /><button
          type="button"
          :disabled="candidateLoading || busy"
          @click="selectSection(section.items)"
        >
          全选 / 取消本栏</button
        ><label v-for="candidate in section.items" :key="candidate.id"
          ><input
            v-model="selected"
            type="checkbox"
            :value="candidate.id"
            :disabled="
              !selected.includes(candidate.id) && selected.length >= capacity
            "
          />{{ candidate.remark || candidate.nickname }}</label
        >
      </section>
      <p>已选 {{ selected.length }} 人 / 还可添加 {{ capacity }} 人</p>
      <button
        v-if="candidateMore"
        type="button"
        @click="
          candidatePage++;
          choices(true);
        "
      >
        加载更多好友</button
      ><template v-if="inviteMode"
        ><label
          ><input
            v-model="allowHistory"
            type="checkbox"
          />允许新成员查看入群前的历史消息</label
        ><button
          class="primary"
          :disabled="!selected.length || busy"
          @click="manage('invite')"
        >
          邀请 {{ selected.length }} 人
        </button></template
      >
    </section>
    <template v-if="managing && group?.can_manage" #footer>
      <button type="button" class="ui-text-button" :disabled="busy" @click="settingsView === 'overview' ? emit('close') : settingsPage(settingsView === 'exceptions' ? 'permissions' : 'overview')">{{ settingsView === "overview" ? "取消" : "返回" }}</button>
      <button v-if="settingsView === 'overview'" type="button" class="ui-text-button group-edit-save" :disabled="busy || !name.trim()" @click="save">{{ busy ? "保存中…" : "保存" }}</button>
      <button v-else type="button" class="ui-text-button group-edit-save" :disabled="busy" @click="settingsPage(settingsView === 'exceptions' ? 'permissions' : 'overview')">完成</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.group-edit { font-size: 14px; }
.group-edit-identity { display: flex; align-items: center; gap: 22px; padding: 6px 22px 12px; }
.group-edit label.group-edit-avatar { margin: 0; position: relative; display: block; flex: none; width: 66px; height: 66px; cursor: pointer; }
.group-edit-avatar .avatar { --avatar-size: 66px; --avatar-radius: 50%; }
.group-edit-avatar input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; }
.group-edit-avatar:focus-within { outline: 2px solid var(--ui-primary); outline-offset: 4px; border-radius: 50%; }
.group-edit-camera { position: absolute; right: -2px; bottom: -2px; background: var(--ui-primary); color: #fff; border: 2px solid var(--ui-surface); border-radius: 50%; padding: 3px; display: grid; }
.group-edit-camera .ui-icon { width: 13px; height: 13px; }
.group-edit label.group-edit-name { margin: 0; min-width: 0; flex: 1; color: var(--ui-primary); font-size: 12px; }
.group-edit .group-edit-name input { display: block; width: 100%; margin-top: 4px; border: 0; border-bottom: 2px solid var(--ui-primary); border-radius: 0; padding: 6px 0; background: transparent; color: var(--ui-text); font-size: 14px; outline: none; box-shadow: none; }
.group-edit textarea.group-edit-description { width: calc(100% - 44px); margin: 0 22px 10px; min-height: 40px; max-height: 130px; resize: vertical; border: 0; border-radius: 0; background: transparent; padding: 4px 0; font-size: 13px; }
.group-edit-description::placeholder { color: var(--ui-muted); }
.group-edit-section { border-top: 7px solid var(--ui-surface-soft); padding: 4px 0; }
.group-edit-row { display: flex; width: 100%; min-height: 39px; align-items: center; gap: 15px; border: 0; border-radius: 0; background: transparent; padding: 8px 22px; text-align: start; font-size: 14px; }
.group-edit-row:hover:not(:disabled) { background: var(--ui-surface-soft); }
.group-edit-row > .ui-icon { flex: none; width: 18px; height: 18px; color: var(--ui-muted); }
.group-edit-row > span { flex: 1; min-width: 0; }
.group-edit-row > small { max-width: 53%; text-align: end; color: var(--ui-primary); font-size: 12px; }
.group-edit-detail { min-height: 280px; padding: 4px 20px 18px; }
.group-edit-detail .group-edit-row { padding-inline: 0; }
.group-edit-help { color: var(--ui-muted); font-size: 12px; line-height: 1.65; margin-block: 8px 14px; }
.group-edit-option { display: flex; align-items: center; gap: 12px; min-height: 64px; padding-block: 12px; border-bottom: 1px solid var(--ui-line); }
.group-edit-option > span { flex: 1; }
.group-edit-option small { display: block; margin-top: 4px; color: var(--ui-muted); font-size: 12px; line-height: 1.5; }
.group-edit-option input { flex: none; accent-color: var(--ui-primary); }
.group-edit-field { display: grid; gap: 8px; margin-block: 12px; }
.group-edit-field textarea { resize: vertical; min-height: 190px; max-height: 50vh; }
.group-edit-field > small { color: var(--ui-muted); text-align: end; font-size: 12px; }
.group-edit-error { color: var(--ui-danger, #c44444); margin: 8px 20px 16px; }
.group-edit-confirm { margin-top: 14px; padding: 12px; border: 1px solid var(--ui-line); border-radius: 6px; }
.group-edit-confirm p { margin-bottom: 10px; }
.group-edit-confirm button + button { margin-left: 8px; }
.group-edit-destructive { width: 100%; margin-top: 20px; }
.group-edit-member { display: flex; align-items: center; gap: 9px; min-height: 56px; border-bottom: 1px solid var(--ui-line); }
.group-edit-member .avatar { --avatar-radius: 50%; }
.group-edit-person { flex: 1; min-width: 0; }
.group-edit-person strong { display: block; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-edit-person small { display: block; color: var(--ui-muted); font-size: 12px; }
.group-edit-save { font-weight: 600; }
.group-edit h3.group-permission-heading { margin: 8px 0 16px; color: var(--ui-primary); font-size: 13px; font-weight: 600; }
.group-edit .group-permission-option { display: flex; flex-wrap: nowrap; align-items: center; justify-content: space-between; gap: 16px; min-height: 36px; margin: 0; font-size: 13px; }
.group-permission-option input.group-permission-switch { appearance: none; position: relative; width: 30px; min-width: 30px; height: 17px; min-height: 17px; margin: 0; padding: 0; border: 0; border-radius: 10px; background: #df777b; cursor: pointer; }
.group-permission-switch::after { content: '×'; position: absolute; display: grid; place-items: center; width: 13px; height: 13px; left: 2px; top: 2px; border-radius: 50%; color: #c84f56; background: #fff; font-size: 12px; line-height: 1; }
.group-permission-option input.group-permission-switch:checked { background: #41add8; }
.group-permission-switch:checked::after { content: '✓'; left: 15px; color: #299acb; font-size: 10px; }
.group-permission-option input.group-permission-switch:disabled { cursor: default; opacity: .5; }
.group-permission-locked { display: grid; place-items: center start; width: 30px; height: 17px; padding-left: 3px; border-radius: 10px; color: #fff; background: #df777b; }
.group-permission-locked .ui-icon { width: 12px; height: 12px; }
.group-permission-note { margin: 16px -20px 10px; padding: 10px 20px; background: var(--ui-surface-soft); color: var(--ui-muted); font-size: 12px; line-height: 1.65; }
.group-permission-exceptions { border-top: 1px solid var(--ui-line); margin-top: 12px; }
.group-edit-person { min-width: 60px; }
.group-admin-action { flex: none; font-size: 12px; padding-inline: 5px; }
.group-exception-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px; margin-block: 12px; border: 1px solid var(--ui-line); border-radius: 6px; }
.group-exception-form label { display: flex; align-items: center; gap: 8px; width: 100%; }
.group-exception-form input { min-width: 0; width: 90px; }
.group-exception-form > small { width: 100%; color: var(--ui-muted); }

.group-tabs {
  display: flex;
  gap: 18px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--ui-line);
}
.group-tabs button {
  min-height: 40px;
  padding: 6px 4px;
  background: transparent;
  border-radius: 0;
  border-bottom: 2px solid transparent;
  color: var(--ui-muted);
  font-size: var(--ui-font-control);
}
.group-tabs button[aria-selected="true"] {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
  font-weight: var(--ui-weight-strong);
}
.group-profile-copy dt {
  margin-top: 12px;
  font-weight: var(--ui-weight-strong);
}
.group-profile-copy dd {
  white-space: pre-wrap;
  color: var(--ui-muted);
}
.group-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px;
  margin-bottom: 15px;
  border: 1px solid var(--panel-line);
  border-radius: 8px;
  background: var(--panel-field);
}
.group-summary .avatar {
  --avatar-size: 44px;
}
.group-summary h3 {
  margin: 0 0 4px;
  font-size: 15px;
  overflow-wrap: anywhere;
}
.group-summary p {
  font-size: 12px;
  color: var(--panel-muted);
}
.group-members-section {
  margin: 11px 0;
}
.group-actions {
  margin-block: 16px;
}
.group-actions > button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.group-profile-fields {
  padding: 11px;
  border: 1px solid var(--ui-line);
  border-radius: 7px;
  background: var(--ui-surface-soft);
}
.vue-group-member > .avatar {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border-radius: 50%;
}
.vue-group-member .vue-group-person > button {
  padding: 0;
  min-height: 24px;
  background: transparent;
  text-align: left;
  overflow-wrap: anywhere;
}
.vue-group-candidates {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--panel-line);
}
.vue-group-candidates > section {
  padding-block: 10px;
  border-bottom: 1px solid var(--panel-line);
}
</style>
