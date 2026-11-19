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

const props = defineProps<{
  conversation: Conversation;
  showMemberCount: boolean;
  refreshRevision: number;
}>();
const emit = defineEmits<{
  member: [action: MemberSocialAction, member: Member];
  updated: [];
}>();
const chat = inject(chatKey)!;
const group = shallowRef<Group | null>(null);
const busy = shallowRef(false);
const actorRole = computed(() => group.value?.my_role ?? props.conversation.my_role);
const canManage = computed(() => ["owner", "admin"].includes(actorRole.value ?? ""));
const canAdd = computed(() => group.value?.allow_member_add_friend ??
  (group.value?.block_member_friend_requests === false));
const canProfile = (member: Member) => !!member.is_contact || canAdd.value ||
  canManage.value || member.id === chat.me.value?.id;
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
const groupFailed = shallowRef(false);
const membersFailed = shallowRef(false);
const loading = shallowRef(true);
const page = shallowRef(1);
const hasMore = shallowRef(false);
const searchOpen = shallowRef(false);
const keyword = shallowRef("");
const applied = shallowRef("");
const searchField = useTemplateRef<HTMLInputElement>("searchField");
const memberList = useTemplateRef<HTMLElement>("memberList");
let groupRequest: AbortController | undefined;
let memberRequest: AbortController | undefined;
const memberCount = computed(
  () => group.value?.member_count ?? props.conversation.member_count,
);
const timeoutOptions = (request: AbortController) => ({
  signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
});

async function loadGroup() {
  groupRequest?.abort();
  const request = new AbortController();
  groupRequest = request;
  groupFailed.value = false;
  try {
    const id = chat.client.wire("conversation", props.conversation.id);
    const data = await chat.client.raw<Group>(`/groups/${id}`, timeoutOptions(request));
    if (groupRequest === request) group.value = data;
  } catch {
    if (groupRequest === request) groupFailed.value = true;
  }
}
async function loadMembers(append = false) {
  memberRequest?.abort();
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
    const roster = await chat.api<Page<Member>>(
      `/conversations/members?${params}`,
      timeoutOptions(request),
    );
    if (memberRequest !== request) return;
    members.value = append ? [...members.value, ...roster.items] : roster.items;
    page.value = nextPage;
    hasMore.value = roster.has_more === true;
  } catch (cause) {
    if (memberRequest !== request) return;
    membersFailed.value = true;
    const status = (cause as { status?: number } | null)?.status;
    if (status === 401 || status === 426) chat.error(cause);
  } finally {
    if (memberRequest === request) loading.value = false;
  }
}
function submitSearch() {
  applied.value = keyword.value.trim();
  members.value = [];
  hasMore.value = false;
  if (memberList.value) memberList.value.scrollTop = 0;
  void loadMembers();
}
function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value) {
    keyword.value = "";
    if (applied.value) submitSearch();
  }
}
watch(searchField, (field) => field?.focus(), { flush: "post" });
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
  const requests = [groupRequest, memberRequest];
  groupRequest = undefined;
  memberRequest = undefined;
  requests.forEach((request) => request?.abort());
});
</script>

<template>
  <aside class="group-sidebar" aria-label="群聊信息">
    <section class="group-sidebar-announcement" aria-label="群公告">
      <h3>群公告</h3>
      <button
        v-if="groupFailed"
        type="button"
        class="ui-text-button"
        @click="loadGroup"
      >
        重试
      </button>
      <p v-else-if="group?.announcement" class="announcement-text" tabindex="0">
        {{ group.announcement }}
      </p>
      <p v-else class="group-sidebar-muted" role="status">
        {{ group ? "暂无群公告" : "加载中…" }}
      </p>
    </section>
    <section class="group-sidebar-roster" aria-label="群成员列表">
      <header>
        <h3>
          群成员
          <span v-if="showMemberCount && memberCount != null">{{
            memberCount
          }}</span>
        </h3>
        <button
          type="button"
          class="ui-icon-button group-sidebar-search-toggle"
          aria-label="搜索群成员"
          title="搜索群成员"
          :aria-expanded="searchOpen"
          @click="toggleSearch"
        >
          <UiIcon :name="searchOpen ? 'close' : 'search'" />
        </button>
      </header>
      <form
        v-if="searchOpen"
        class="group-sidebar-search"
        @submit.prevent="submitSearch"
      >
        <input
          ref="searchField"
          v-model="keyword"
          aria-label="昵称或用户名"
          placeholder="昵称或用户名"
          maxlength="100"
          spellcheck="false"
          autocomplete="off"
          @keydown.esc.stop.prevent="toggleSearch"
        />
        <button
          type="submit"
          class="ui-icon-button"
          aria-label="执行群成员搜索"
          title="搜索"
        >
          <UiIcon name="search" />
        </button>
      </form>
      <div ref="memberList" class="group-sidebar-scroll" :aria-busy="loading">
        <ul v-if="members.length">
          <li v-for="member in members" :key="member.id">
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
              <AvatarImage :name="member.nickname" :src="member.avatar_url" />
              <span class="group-sidebar-name" :title="member.nickname">
                {{ chat.contactName(member.id, member.nickname) }}
              </span>
              <span
                v-if="member.role !== 'member'"
                class="group-sidebar-role"
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
  background: var(--ui-surface-soft);
}
.group-sidebar h3 {
  font-size: var(--ui-font-control);
  font-weight: var(--ui-weight-strong);
  line-height: var(--ui-line-heading);
}
.group-sidebar-announcement {
  flex: none;
  display: grid;
  align-content: start;
  gap: 7px;
  padding: 14px 14px 12px;
  border-bottom: 1px solid var(--ui-line);
}
.announcement-text {
  max-height: min(100px, 18vh);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  color: var(--ui-muted);
  font-size: var(--ui-font-secondary);
  line-height: var(--ui-line-content);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
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
  padding: 5px 8px 2px 14px;
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
  display: flex;
  align-items: center;
  margin: 1px 10px 6px;
  border: 1px solid var(--ui-line);
  border-radius: 6px;
  background: var(--ui-surface);
}
.group-sidebar-search:focus-within {
  border-color: var(--ui-focus);
}
.group-sidebar-search input {
  flex: 1;
  width: 0;
  padding: 5px 0 5px 8px;
  color: var(--ui-text);
  background: transparent;
  font-size: 12px;
  outline: none;
}
.group-sidebar-search button {
  width: 32px;
  height: 32px;
  font-size: 15px;
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
  --avatar-size: 27px;
  --avatar-radius: 50%;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
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
.group-sidebar-role {
  flex: none;
  margin-inline-start: auto;
  color: var(--ui-muted);
  font-size: var(--ui-font-caption);
}
.group-sidebar-muted-icon,
.group-sidebar-muted {
  color: var(--ui-muted);
  font-size: 12px;
}
.group-sidebar-scroll > .group-sidebar-muted {
  padding: 7px 8px;
}
.group-sidebar-more {
  display: flex;
  margin: 6px auto;
  font-size: 12px;
}
</style>
