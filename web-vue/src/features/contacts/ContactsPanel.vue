<script setup lang="ts">
import {
  computed,
  inject,
  onScopeDispose,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import { chatKey } from "../../composables/useChat";
import BaseDialog from "../../components/BaseDialog.vue";
import AvatarImage from "../../components/AvatarImage.vue";
import ContactIdentity from "./ContactIdentity.vue";
import { messageOf } from "../../api/client";
import ContactsDirectory, {
  type ContactEntry,
  type ContactSection,
} from "./ContactsDirectory.vue";
import type {
  Conversation,
  FriendRequest,
  Page,
  Profile,
} from "../../api/types";
const props = defineProps<{
  userId?: number;
  card?: { conversation: number; message: number } | null;
  contextId?: number;
  initialSection?: ContactSection;
}>();
const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const mode = shallowRef<ContactSection>(props.initialSection ?? "friends");
const keyword = shallowRef("");
const searchTerm = shallowRef("");
const contacts = shallowRef<ContactEntry[]>([]);
const requests = shallowRef<FriendRequest[]>([]);
const listLoading = shallowRef(false);
const listFailed = shallowRef(false);
const notice = shallowRef("");
const requestRecipient = shallowRef<{
  id: number;
  name: string;
  avatar?: string;
} | null>(null);
const requestNote = shallowRef("");
const requestError = shallowRef("");
const noteInput = useTemplateRef<HTMLTextAreaElement>("noteInput");
watch(noteInput, (input) => input?.focus({ preventScroll: true }), {
  flush: "post",
});
let listRequest: AbortController | undefined;
let directoryLoaded = false;
const profile = shallowRef<Profile | null>(null),
  common = shallowRef<Conversation[]>([]),
  remark = shallowRef(""),
  groupName = shallowRef(""),
  busy = shallowRef(false),
  page = shallowRef(1),
  hasMore = shallowRef(false),
  staffDetails = shallowRef<Record<string, unknown> | null>(null);
const clearedKey = "pulse_vue_friend_requests_cleared:" + chat.me.value?.id;
const cleared = shallowRef<number[]>([]);
try {
  const value = JSON.parse(localStorage.getItem(clearedKey) || "[]");
  if (Array.isArray(value)) cleared.value = value.filter(Number.isSafeInteger);
} catch {}
const visibleRequests = computed(() =>
  requests.value.filter(
    (row) => row.status === "pending" && !cleared.value.includes(row.id),
  ),
);
function clearRequests() {
  cleared.value = [
    ...new Set([
      ...cleared.value,
      ...visibleRequests.value.map((row) => row.id),
    ]),
  ].slice(-300);
  localStorage.setItem(clearedKey, JSON.stringify(cleared.value));
}
let revision = 0;
const abort = new AbortController();
const orderedContacts = computed(() =>
  [...contacts.value].sort((a, b) =>
    (a.remark || a.nickname).localeCompare(b.remark || b.nickname, "zh-CN"),
  ),
);
const visibleContacts = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  if (mode.value === "search" || !query) return orderedContacts.value;
  return orderedContacts.value.filter((row) =>
    [row.remark, row.nickname, row.username, row.public_id].some((value) =>
      value?.toLowerCase().includes(query),
    ),
  );
});
function cancelList() {
  listRequest?.abort();
  listRequest = undefined;
  listLoading.value = false;
}
function changeKeyword(value: string) {
  keyword.value = value;
  notice.value = "";
  if (mode.value !== "search" || value.trim() === searchTerm.value) return;
  cancelList();
  searchTerm.value = "";
  contacts.value = [];
  listFailed.value = false;
}
function search() {
  if (!keyword.value.trim()) return;
  notice.value = "";
  searchTerm.value = keyword.value.trim();
  void load();
}
async function load(append = false) {
  const section = mode.value;
  if (section === "search" && !searchTerm.value) return;
  cancelList();
  const request = new AbortController();
  listRequest = request;
  listLoading.value = true;
  listFailed.value = false;
  directoryLoaded = true;
  const options = {
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
  };
  try {
    if (section === "requests") {
      const result = await chat.api<Page<FriendRequest>>(
        "/contact-requests?direction=received&size=100",
        options,
      );
      if (listRequest === request) requests.value = result.items;
      return;
    }
    if (section === "blocked") {
      const result = await chat.api<
        Page<Omit<ContactEntry, "id"> & { blocked_id: number }>
      >("/blocks", options);
      if (listRequest === request)
        contacts.value = result.items.map(({ blocked_id, ...row }) => ({
          id: blocked_id,
          ...row,
        }));
      return;
    }
    const nextPage = append ? page.value + 1 : 1;
    const result = await chat.api<Page<Profile>>(
      section === "search"
        ? "/contacts/search?q=" + encodeURIComponent(searchTerm.value)
        : `/contacts?page=${nextPage}&size=100`,
      options,
    );
    if (listRequest !== request) return;
    contacts.value = append
      ? [...contacts.value, ...result.items]
      : result.items;
    page.value = nextPage;
    hasMore.value =
      section === "friends" &&
      (result.has_more ??
        (result.items.length === 100 &&
          (result.total == null || contacts.value.length < result.total)));
  } catch (cause) {
    if (listRequest !== request) return;
    listFailed.value = true;
    const status = (cause as { status?: number } | null)?.status;
    if (status === 401 || status === 426) chat.error(cause);
  } finally {
    if (listRequest === request) {
      listRequest = undefined;
      listLoading.value = false;
    }
  }
}
function showDirectory() {
  profile.value = null;
  if (!directoryLoaded) void load();
}
async function detail(id: number) {
  if (busy.value) return;
  const mine = ++revision;
  busy.value = true;
  try {
    const result = await chat.api<Profile>(
      props.card
        ? `/contacts/card-profile?conversation_id=${props.card.conversation}&message_id=${props.card.message}`
        : "/contacts/profile?user_id=" +
            id +
            (props.contextId
              ? "&context_conversation_id=" + props.contextId
              : ""),
    );
    if (mine !== revision) return;
    profile.value = result;
    remark.value = result.remark || "";
    groupName.value = result.group_name || "";
    staffDetails.value = null;
    const commonResult = (
      await chat.api<Page<Conversation>>(
        "/contacts/common-groups?user_id=" +
          id +
          (props.contextId
            ? "&context_conversation_id=" + props.contextId
            : ""),
      )
    ).items;
    if (mine !== revision) return;
    common.value = commonResult;
    if (chat.me.value?.internal_staff) {
      const details = await chat.api<Record<string, unknown>>(
        "/contacts/internal-profile?user_id=" +
          id +
          (props.contextId
            ? "&context_conversation_id=" + props.contextId
            : ""),
      );
      if (mine === revision) staffDetails.value = details;
    }
  } catch (cause) {
    if (mine === revision) chat.error(cause);
  } finally {
    if (mine === revision) busy.value = false;
  }
}
async function submitFriendRequest() {
  const recipient = requestRecipient.value;
  if (!recipient || busy.value) return;
  busy.value = true;
  requestError.value = "";
  try {
    await chat.post("/contact-requests", {
      to_user_id: recipient.id,
      message: requestNote.value,
      ...(props.contextId ? { context_conversation_id: props.contextId } : {}),
      ...(props.card
        ? {
            card_conversation_id: props.card.conversation,
            card_message_id: props.card.message,
          }
        : {}),
    });
    requestRecipient.value = null;
    profile.value = null;
    notice.value = "好友申请已发送";
    await load();
    void chat.loadDirectory();
    void chat.refreshNames();
    void chat.refreshNotificationCount();
  } catch (cause) {
    const status = (cause as { status?: number } | null)?.status;
    if (status === 401 || status === 426) chat.error(cause);
    else requestError.value = messageOf(cause);
  } finally {
    busy.value = false;
  }
}
async function operation(action: string, target: number) {
  if (busy.value) return;
  if (action === "request") {
    const recipient =
      profile.value ?? contacts.value.find((row) => row.id === target);
    if (!recipient) return;
    requestNote.value = "";
    requestError.value = "";
    requestRecipient.value = {
      id: target,
      name: recipient.remark || recipient.nickname,
      avatar: recipient.avatar_url,
    };
    return;
  }
  busy.value = true;
  try {
    if (action === "chat") {
      const row = await chat.post<Conversation>("/conversations/direct", {
        user_id: target,
      });
      await chat.choose(row.id);
      emit("close");
    }
    if (action === "force")
      await chat.post("/contacts/force-add", { user_id: target });
    if (action === "remove" && confirm("删除这个好友？"))
      await chat.post("/contacts/remove", { user_id: target });
    if (action === "block" && confirm("拉黑这个用户？"))
      await chat.post("/blocks", { user_id: target, reason: "用户操作" });
    if (action === "unblock")
      await chat.post("/blocks/unblock", { user_id: target });
    if (action === "remark")
      await chat.post("/contacts/remark", {
        user_id: target,
        remark: remark.value,
        group_name: groupName.value,
      });
    if (action === "accept" || action === "reject")
      await chat.post("/contact-requests/handle", {
        request_id: target,
        action,
      });
    if (action !== "chat") {
      profile.value = null;
      await load();
      void chat.loadDirectory();
      void chat.refreshNames();
      void chat.refreshNotificationCount();
    }
  } catch (cause) {
    chat.error(cause);
  } finally {
    busy.value = false;
  }
}
watch(mode, () => {
  cancelList();
  notice.value = "";
  keyword.value = "";
  searchTerm.value = "";
  contacts.value = [];
  requests.value = [];
  hasMore.value = false;
  listFailed.value = false;
  void load();
});
if (props.userId) void detail(props.userId);
else void load();
onScopeDispose(() => {
  revision++;
  cancelList();
  abort.abort();
});
</script>
<template>
  <BaseDialog
    :title="requestRecipient ? '发送好友验证' : profile ? '个人资料' : '联系人'"
    :size="profile || requestRecipient ? 'compact' : undefined"
    :layout="profile || requestRecipient ? undefined : 'contacts'"
    :busy="busy && !!requestRecipient"
    @close="requestRecipient ? (requestRecipient = null) : emit('close')"
  >
    <form
      v-if="requestRecipient"
      id="contact-request-form"
      class="contact-request-form"
      @submit.prevent="submitFriendRequest"
    >
      <ContactIdentity
        :name="requestRecipient.name"
        :avatar="requestRecipient.avatar"
      />
      <label>
        验证消息
        <textarea
          ref="noteInput"
          v-model="requestNote"
          rows="3"
          placeholder="介绍一下自己（选填）"
          :disabled="busy"
        />
      </label>
      <p v-if="requestError" role="alert">{{ requestError }}</p>
    </form>
    <template v-else-if="profile">
      <button class="ui-text-button" @click="showDirectory">返回联系人</button>
      <header class="contact-profile-head flex items-center gap-3">
        <AvatarImage :name="profile.nickname" :src="profile.avatar_url" />
        <h3>{{ profile.nickname }}</h3>
      </header>
      <p v-if="profile.add_friend_restriction" role="status">
        {{ profile.add_friend_restriction }}
      </p>
      <dl class="vue-details">
        <dt>账号</dt>
        <dd>{{ profile.username || "未公开" }}</dd>
        <dt>用户 ID</dt>
        <dd>{{ profile.public_id }}</dd>
        <dt>数字 ID</dt>
        <dd>{{ profile.id }}</dd>
        <dt>个性签名</dt>
        <dd>{{ profile.signature }}</dd>
        <dt>状态</dt>
        <dd>
          {{
            profile.last_seen_hidden
              ? "最近上线已隐藏"
              : profile.online
                ? "在线"
                : profile.last_seen_at || "离线"
          }}
        </dd>
      </dl>
      <label
        >备注<input v-model="remark" :disabled="!profile.is_contact" /></label
      ><label
        >好友分组<input v-model="groupName" :disabled="!profile.is_contact"
      /></label>
      <div class="vue-action-list">
        <button
          :disabled="busy || !profile.is_contact"
          @click="operation('remark', profile.id)"
        >
          保存备注</button
        ><button :disabled="busy" @click="operation('chat', profile.id)">
          发送消息 / 临时聊天</button
        ><button
          v-if="!profile.is_contact"
          :disabled="busy || profile.can_add_friend === false"
          @click="operation('request', profile.id)"
        >
          添加好友</button
        ><button
          v-if="chat.me.value?.internal_staff && !profile.is_contact"
          :disabled="busy"
          @click="operation('force', profile.id)"
        >
          直接添加好友</button
        ><button
          v-if="profile.is_contact"
          :disabled="busy"
          @click="operation('remove', profile.id)"
        >
          删除好友</button
        ><button
          :disabled="busy"
          @click="
            operation(profile.blocked_by_me ? 'unblock' : 'block', profile.id)
          "
        >
          {{ profile.blocked_by_me ? "解除屏蔽" : "拉黑好友" }}
        </button>
      </div>
      <h4>共同群组</h4>
      <button
        v-for="group in common"
        :key="group.id"
        @click="
          chat.choose(group.id);
          emit('close');
        "
      >
        {{ group.name }}
      </button>
      <details v-if="staffDetails">
        <summary>内部人员资料</summary>
        <dl class="vue-details">
          <template v-for="(value, key) in staffDetails" :key="key"
            ><dt>{{ key }}</dt>
            <dd>
              {{ typeof value === "object" ? JSON.stringify(value) : value }}
            </dd></template
          >
        </dl>
      </details></template
    >
    <ContactsDirectory
      v-else
      :section="mode"
      :keyword="keyword"
      :contacts="visibleContacts"
      :requests="visibleRequests"
      :loading="listLoading || (busy && !directoryLoaded)"
      :working="busy"
      :failed="listFailed"
      :searched="!!searchTerm"
      :notice="notice"
      :has-more="hasMore"
      @select="mode = $event"
      @update:keyword="changeKeyword"
      @search="search"
      @retry="load()"
      @more="load(true)"
      @profile="detail"
      @action="operation"
      @clear-requests="clearRequests"
    />
    <template v-if="requestRecipient" #footer>
      <button
        type="button"
        class="ui-text-button"
        :disabled="busy"
        @click="requestRecipient = null"
      >
        取消
      </button>
      <button
        type="submit"
        class="primary"
        form="contact-request-form"
        :disabled="busy"
      >
        {{ busy ? "发送中…" : "发送申请" }}
      </button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.contact-request-form {
  display: grid;
  gap: 16px;
}
.contact-request-form label {
  display: grid;
  gap: 8px;
  margin: 0;
}
.contact-profile-head {
  padding: 9px 0 12px;
  border-bottom: 1px solid var(--ui-line);
}
.contact-profile-head .avatar {
  --avatar-size: 48px;
}
.contact-profile-head h3 {
  margin: 0;
  font-size: 17px;
}
</style>
