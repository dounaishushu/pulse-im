<script setup lang="ts">
import {
  computed,
  inject,
  onScopeDispose,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import type { Conversation, Group, Member, Page } from "../../api/types";
import { chatKey } from "../../composables/useChat";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import GroupMemberMenu from "./GroupMemberMenu.vue";
import { isMemberSocialAction, manageGroupMember, type MemberAction, type MemberSocialAction } from "./memberActions";
import { canViewGroupMember, sortGroupMembers } from "./memberPresentation";

const props = defineProps<{
  conversation: Conversation;
  showMemberCount: boolean;
  refreshRevision: number;
}>();
const emit = defineEmits<{
  member: [action: MemberSocialAction, member: Member];
  updated: [];
  manage: [];
  invite: [];
  close: [];
}>();
const chat = inject(chatKey)!;
const group = shallowRef<Group | null>(null);
const busy = shallowRef(false);
const actorRole = computed(() => props.conversation.my_role ?? group.value?.my_role);
const canManage = computed(() => !groupFailed.value && !!group.value?.can_manage && ["owner", "admin"].includes(actorRole.value ?? ""));
const toolbarBusy = shallowRef(false);
const notificationsMuted = computed(() => props.conversation.notifications_muted === true);
const allMuted = computed(() => group.value?.all_muted === true);
const canAdd = computed(() => group.value?.allow_member_add_friend ??
  (group.value?.block_member_friend_requests === false));
const canProfile = (member: Member) => canViewGroupMember(group.value, member.id, chat.me.value?.id);
async function runMemberAction(action: MemberAction, member: Member) {
  if (isMemberSocialAction(action)) {
    emit("member", action, member);
    return;
  }
  if (busy.value) return;
  busy.value = true;
  try {
    if (await manageGroupMember(chat, props.conversation.id, member.id, action)) {
      emit("updated");
      void chat.loadDirectory();
    }
  } catch (cause) {
    if (chat.active.value?.id === props.conversation.id) chat.error(cause);
  } finally {
    busy.value = false;
  }
}
const members = shallowRef<Member[]>([]);
const managers = shallowRef<Member[]>([]);
const managersLoading = shallowRef(false);
const managersFailed = shallowRef(false);
const displayedMembers = computed(() => sortGroupMembers(applied.value ? members.value : [...members.value, ...managers.value]));
const groupFailed = shallowRef(false);
const membersFailed = shallowRef(false);
const loading = shallowRef(true);
const page = shallowRef(1);
const hasMore = shallowRef(false);
const keyword = shallowRef("");
const applied = shallowRef("");
const memberList = useTemplateRef<HTMLElement>("memberList");
let groupRequest: AbortController | undefined;
let memberRequest: AbortController | undefined;
let managerRequest: AbortController | undefined;
const memberCount = computed(
  () => group.value?.member_count ?? props.conversation.member_count,
);
const timeoutOptions = (request: AbortController) => ({
  signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
  deferMedia: true,
});

async function loadGroup() {
  groupRequest?.abort();
  const request = new AbortController();
  groupRequest = request;
  groupFailed.value = false;
  try {
    const data = await chat.api<Group>(`/conversations/groups/profile?conversation_id=${props.conversation.id}`, timeoutOptions(request));
    if (groupRequest === request) group.value = data;
  } catch {
    if (groupRequest === request) groupFailed.value = true;
  }
}
async function toolbarAction(action: "notifications" | "mute-all") {
  if (toolbarBusy.value || chat.locked.value || (action === "mute-all" && !canManage.value)) return;
  const source = props.conversation.id;
  toolbarBusy.value = true;
  try {
    if (action === "notifications") await chat.post("/conversations/settings", {
      conversation_id: source, notifications_muted: !notificationsMuted.value,
    });
    else await chat.post("/conversations/groups/settings", {
      conversation_id: source, all_muted: !allMuted.value,
    });
    await chat.loadDirectory();
    if (chat.active.value?.id === source) {
      await loadGroup();
      emit("updated");
    }
  } catch (cause) {
    if (chat.active.value?.id === source) chat.error(cause);
  } finally { toolbarBusy.value = false; }
}
async function loadMembers(append = false) {
  memberRequest?.abort();
  managerRequest?.abort();
  managerRequest = undefined;
  managersLoading.value = false;
  managersFailed.value = false;
  if (!append) managers.value = [];
  const request = new AbortController();
  memberRequest = request;
  const nextPage = append ? page.value + 1 : 1;
  loading.value = true;
  membersFailed.value = false;
  try {
    const params = new URLSearchParams({
      conversation_id: String(props.conversation.id),
      q: applied.value,
      page: String(nextPage),
    });
    const roster = await chat.api<Page<Member> & { members_visibility: string }>(
      `/conversations/members?${params}`,
      timeoutOptions(request),
    );
    if (memberRequest !== request) return;
    members.value = append ? [...members.value, ...roster.items] : roster.items;
    page.value = nextPage;
    hasMore.value = roster.has_more === true;
    if (hasMore.value && !applied.value && !managers.value.length) void loadManagers(request, roster.members_visibility);
  } catch (cause) {
    if (memberRequest !== request) return;
    membersFailed.value = true;
    const status = (cause as { status?: number } | null)?.status;
    if (status === 401 || status === 426) chat.error(cause);
  } finally {
    if (memberRequest === request) loading.value = false;
  }
}
async function loadManagers(source: AbortController, visibility: string) {
  if (source !== memberRequest || source.signal.aborted) return;
  const request = new AbortController();
  managerRequest = request;
  managersLoading.value = true;
  try {
    // Keep the existing directory pagination; complete managers separately so
    // an owner/admin on a later user-ID page still appears at the top.
    const result = await chat.api<Page<Member> & {
      conversation_id: number; managers_only: boolean; viewer_role: string; members_visibility: string;
    }>(`/conversations/members?conversation_id=${props.conversation.id}&roles=managers`, timeoutOptions(request));
    if (managerRequest !== request || memberRequest !== source) return;
    if (result.viewer_role !== actorRole.value || result.members_visibility !== visibility) {
      members.value = []; managers.value = []; hasMore.value = false;
      membersFailed.value = true;
      void loadGroup();
      return;
    }
    if (result.conversation_id !== props.conversation.id || result.managers_only !== true ||
      result.has_more !== false ||
      result.items.some(row => !["owner", "admin"].includes(row.role))) throw Error("成员权限已变化，请刷新");
    managers.value = result.items;
  } catch (cause) {
    if (managerRequest !== request || memberRequest !== source) return;
    managersFailed.value = true;
    if ([401, 403].includes((cause as { status?: number }).status ?? 0)) {
      members.value = []; managers.value = []; hasMore.value = false;
    }
  } finally {
    if (managerRequest === request) managersLoading.value = false;
  }
}
function submitSearch() {
  applied.value = keyword.value.trim();
  members.value = [];
  hasMore.value = false;
  if (memberList.value) memberList.value.scrollTop = 0;
  void loadMembers();
}
function resetSearch() { keyword.value = ""; submitSearch(); }
watch(
  [
    () => props.refreshRevision,
    () => props.conversation.membership_version,
    () => props.conversation.my_role,
  ],
  ([, version, role], previous) => {
    if (previous?.length && (version !== previous[1] || role !== previous[2])) {
      members.value = [];
      hasMore.value = false;
    }
    void loadGroup();
    void loadMembers();
  },
  { immediate: true },
);
onScopeDispose(() => {
  const requests = [groupRequest, memberRequest, managerRequest];
  groupRequest = undefined;
  memberRequest = undefined;
  managerRequest = undefined;
  requests.forEach((request) => request?.abort());
});
</script>

<template>
  <aside class="group-sidebar" aria-label="群聊信息">
    <section class="group-sidebar-overview" aria-label="群组功能">
      <header class="group-sidebar-heading"><h3>群组信息</h3><button type="button" class="ui-icon-button" aria-label="关闭群组信息" @click="emit('close')"><UiIcon name="close" /></button></header>
      <div class="group-sidebar-actions" :class="{ single: !canManage }">
        <button type="button" :disabled="toolbarBusy" :aria-pressed="notificationsMuted" :title="notificationsMuted ? '消息免打扰已开启，点击恢复通知' : '消息通知已开启，点击免打扰'" @click="toolbarAction('notifications')">
          <span class="notification-symbol"><UiIcon name="bell" /><svg v-if="notificationsMuted" class="notification-ban" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="m5 5 14 14" /></svg></span>通知
        </button>
        <button v-if="canManage" type="button" :disabled="toolbarBusy" :title="actorRole === 'owner' ? '群主管理' : '管理员设置'" @click="emit('manage')"><UiIcon name="settings" />管理</button>
        <button v-if="canManage" type="button" :class="{ active: allMuted }" :disabled="toolbarBusy" :aria-pressed="allMuted" title="全体禁言仅限制普通群员，群主和管理员可正常发言" @click="toolbarAction('mute-all')"><UiIcon name="lock" />{{ allMuted ? '解除禁言' : '全体禁言' }}</button>
        <button v-if="canManage && group?.can_invite" type="button" :disabled="toolbarBusy" @click="emit('invite')"><UiIcon name="userAdd" />邀请入群</button>
      </div>
      <p v-if="groupFailed" class="group-sidebar-muted" role="status">群资料加载失败 <button type="button" class="ui-text-button" @click="loadGroup">重试</button></p>
    </section>
    <section class="group-sidebar-roster" aria-label="群成员列表">
      <form
        class="group-sidebar-search"
        role="search"
        aria-label="群成员"
        @submit.prevent="submitSearch"
        @keydown.esc.stop.prevent="resetSearch"
      >
        <input
          v-model="keyword"
          class="group-sidebar-search-input"
          aria-label="搜索群成员"
          placeholder="搜索备注/昵称/用户名/ID"
          maxlength="100"
          spellcheck="false"
          autocomplete="off"
        />
        <button
          type="submit"
          class="ui-icon-button group-sidebar-search-submit"
          aria-label="执行群成员搜索"
          title="搜索"
        >
          <UiIcon name="search" />
        </button>
      </form>
      <header><h3><UiIcon name="group" /> <span v-if="showMemberCount && memberCount != null">{{ memberCount }} 位</span>群成员</h3><button type="button" class="ui-icon-button" aria-label="刷新群成员" :disabled="loading" @click="loadMembers()"><UiIcon name="refresh" /></button></header>
      <div ref="memberList" class="group-sidebar-scroll" :aria-busy="loading">
        <p v-if="managersLoading" class="group-sidebar-muted" role="status">正在补齐群主和管理员…</p>
        <p v-else-if="managersFailed" class="group-sidebar-muted" role="status">群主和管理员尚未加载完整 <button type="button" class="ui-text-button" @click="loadMembers()">重试</button></p>
        <ul v-if="members.length">
          <li v-for="member in displayedMembers" :key="member.id">
            <GroupMemberMenu
              row
              :member="member"
              :owner="actorRole === 'owner'"
              :can-manage="canManage"
              :can-profile="canProfile(member)"
              :can-add="canAdd"
              :self="member.id === chat.me.value?.id"
              :busy="busy"
              @action="runMemberAction($event, member)"
            >
              <AvatarImage :name="member.nickname" :src="member.avatar_url" :media-id="member.avatar_id" />
              <span class="group-sidebar-person" :title="chat.contactName(member.id, member.nickname)">
                <span class="group-sidebar-name">{{ chat.contactName(member.id, member.nickname) }}</span>
                <small>{{ member.online ? '在线' : member.last_seen_hidden ? '最后上线时间已隐藏' : '最近在线时间不可见' }}</small>
              </span>
              <span
                v-if="member.role !== 'member'"
                class="group-sidebar-role"
                :class="{ owner: member.role === 'owner' }"
                >{{ member.role === "owner" ? "群主" : "管理员" }}</span
              >
              <UiIcon
                v-if="member.is_muted"
                name="mute"
                class="group-sidebar-muted-icon"
              />
            </GroupMemberMenu>
          </li>
        </ul>
        <p
          v-if="loading && !members.length"
          class="group-sidebar-muted"
          role="status"
        >
          正在加载成员…
        </p>
        <div
          v-else-if="membersFailed"
          class="group-sidebar-muted"
          role="status"
        >
          成员加载失败
          <button type="button" class="ui-text-button" @click="loadMembers()">
            重试
          </button>
        </div>
        <p
          v-else-if="!members.length"
          class="group-sidebar-muted"
          role="status"
        >
          {{ applied ? "未找到可见成员" : "暂无可见成员" }}
        </p>
        <button
          v-if="hasMore && !membersFailed"
          type="button"
          class="ui-text-button group-sidebar-more"
          :disabled="loading"
          @click="loadMembers(true)"
        >
          {{ loading ? "加载中…" : "加载更多" }}
        </button>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.group-sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-inline-start: 1px solid var(--ui-line);
  background: var(--ui-surface);
}
.group-sidebar h3 {
  font-size: var(--ui-font-control);
  font-weight: var(--ui-weight-strong);
  line-height: var(--ui-line-heading);
}
.group-sidebar-overview {
  flex: none;
  display: grid;
  align-content: start;
  gap: 7px;
  padding: 8px 12px 12px;
  border-bottom: 1px solid var(--ui-line);
}
.group-sidebar-heading { display: flex; justify-content: space-between; align-items: center; min-height: 28px; }
.group-sidebar-heading h3 { font-weight: 500; }
.group-sidebar-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.group-sidebar-actions.single { grid-template-columns: minmax(0, 1fr); }
.group-sidebar-actions button { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 43px; padding: 6px; border: 1px solid var(--ui-line); border-radius: 7px; background: var(--ui-surface); font-size: 12px; white-space: nowrap; }
.group-sidebar-actions button:hover:not(:disabled) { background: var(--ui-fill); }
.group-sidebar-actions button.active { color: var(--ui-accent, #389acb); border-color: currentColor; }
.group-sidebar-actions button:disabled { opacity: .45; cursor: default; }
.group-sidebar-actions .ui-icon { font-size: 17px; }
.notification-symbol { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 21px; height: 21px; }
.notification-ban { position: absolute; inset: 0; width: 100%; height: 100%; fill: none; stroke: #f04450; stroke-width: 2.4; }
.group-sidebar-roster {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.group-sidebar-roster > header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 0 8px 5px 14px;
  border-bottom: 1px solid var(--ui-line);
}
.group-sidebar-roster h3 span {
  margin-inline-start: 3px;
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.group-sidebar-search-toggle {
  width: 33px;
  height: 33px;
  font-size: 16px;
}
.group-sidebar-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 34px;
  margin: 12px 12px 8px;
  padding-inline: 9px 3px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ui-fill) 76%, var(--ui-surface));
}
.group-sidebar-search:has(.group-sidebar-search-input:focus) {
  border-color: var(--ui-focus);
  background: var(--ui-surface);
}
.group-sidebar-search-input {
  flex: 1;
  min-width: 0;
  width: 100%;
  padding: 4px 0;
  border: 0;
  color: var(--ui-text);
  background: transparent;
  font-size: var(--ui-font-secondary);
}
.group-sidebar-search-input:focus-visible {
  outline: none;
}
.group-sidebar-search-submit {
  width: 28px;
  height: 28px;
  font-size: 15px;
}
.group-sidebar-search-submit:focus-visible {
  outline-offset: -1px;
}
.group-sidebar-scroll {
  min-height: 0;
  padding: 0 6px 8px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.group-sidebar-scroll ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.group-sidebar-scroll :deep(.group-sidebar-member) {
  --avatar-size: 36px;
  --avatar-radius: 50%;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 54px;
  width: 100%;
  padding: 4px 8px;
  background: transparent;
  font-size: var(--ui-font-secondary);
  text-align: start;
}
.group-sidebar-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-sidebar-person { display: grid; gap: 3px; min-width: 0; }
.group-sidebar-person small { color: var(--ui-muted); font-size: 11px; font-weight: 400; }
.group-sidebar-role {
  flex: none;
  margin-inline-start: auto;
  color: #36896f;
  padding: 2px 4px;
  border-radius: 3px;
  background: color-mix(in srgb, #43a783 12%, var(--ui-surface));
  font-size: var(--ui-font-caption);
}
.group-sidebar-muted-icon,
.group-sidebar-muted {
  color: var(--ui-muted);
  font-size: 12px;
}
.group-sidebar-role.owner { color: #9b68d5; background: color-mix(in srgb, #9b68d5 13%, var(--ui-surface)); }
.group-sidebar-scroll > .group-sidebar-muted {
  padding: 7px 8px;
}
.group-sidebar-more {
  display: flex;
  margin: 6px auto;
  font-size: 12px;
}
</style>
