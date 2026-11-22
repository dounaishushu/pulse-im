<script setup lang="ts">
import {
  computed,
  inject,
  onScopeDispose,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import platform from "virtual:pulse-platform";
import { chatKey } from "../../composables/useChat";
import BaseDialog from "../../components/BaseDialog.vue";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import ContactAuditDetails from "./ContactAuditDetails.vue";
import ContactIdentity from "./ContactIdentity.vue";
import { createContactAutosave, type ContactMetadata, type ContactSaveState } from "./contactAutosave";
import { messageOf } from "../../api/client";
import ContactsDirectory, {
  type ContactEntry,
  type ContactSection,
} from "./ContactsDirectory.vue";
import type {
  ContactAudit,
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
  initialRequest?: boolean;
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
  avatarId?: string;
} | null>(null);
const requestNote = shallowRef("");
const requestError = shallowRef("");
const profileError = shallowRef("");
type ProfileSource = { publicId?: string; contextId?: number; card?: typeof props.card; initial?: boolean };
const profileSource = shallowRef<ProfileSource>({ contextId: props.contextId, card: props.card, initial: true });
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
  staffDetails = shallowRef<ContactAudit | null>(null);
const copied = shallowRef("");
const closing = shallowRef(false);
const metadataState = shallowRef<ContactSaveState>({ phase: "idle", draft: { remark: "", group_name: "" }, dirty: false });
type MetadataEditor = { id: number; token: string; save: ReturnType<typeof createContactAutosave> };
let metadata: MetadataEditor | undefined;
let composing = false;
let disposed = false;
function resetMetadata() {
  metadata?.save.stop(); metadata = undefined; composing = false;
  metadataState.value = { phase: "idle", draft: { remark: "", group_name: "" }, dirty: false };
}
function bindMetadata(row: Profile) {
  const token = chat.client.token;
  const previous = metadata?.save.state();
  if (row.is_contact && metadata?.id === row.id && metadata.token === token &&
      (previous?.dirty || previous?.phase === "saving")) {
    composing = false;
    remark.value = previous.draft.remark; groupName.value = previous.draft.group_name;
    if (previous.phase === "waiting") metadata.save.edit(previous.draft);
    return;
  }
  resetMetadata();
  remark.value = row.remark || ""; groupName.value = row.group_name || "";
  if (!row.is_contact) return;
  let editor!: MetadataEditor;
  const save = createContactAutosave({
    initial: { remark: remark.value, group_name: groupName.value },
    write: patch => chat.api<ContactMetadata>("/contacts/remark", {
      method: "POST", authToken: token, body: { user_id: row.id, ...patch },
    }),
    changed: state => {
      if (disposed || metadata !== editor) return;
      metadataState.value = state;
      if (!composing) { remark.value = state.draft.remark; groupName.value = state.draft.group_name; }
    },
    saved: (value, pending) => {
      if (chat.client.token !== token) return;
      chat.rememberContactName(row.id, value.remark);
      if (!disposed && metadata === editor) {
        if (profile.value?.id === row.id) profile.value = { ...profile.value, ...value };
        contacts.value = contacts.value.map(person => person.id === row.id ? { ...person, ...value } : person);
      }
      if (!pending) { void chat.loadDirectory(); void chat.refreshNames(); }
    },
  });
  metadata = editor = { id: row.id, token, save };
}
function metadataInput(key: keyof ContactMetadata, event: Event) {
  if (composing || (event as InputEvent).isComposing || !metadata || !profile.value?.is_contact) return;
  const value = (event.target as HTMLInputElement).value;
  metadata.save.edit({ ...metadata.save.state().draft, [key]: value });
}
function compositionStarted() { composing = true; metadata?.save.pause(); }
function compositionEnded(key: keyof ContactMetadata, event: Event) { composing = false; metadataInput(key, event); }
const flushMetadata = () => composing ? Promise.resolve(false) : metadata?.save.flush() ?? Promise.resolve(true);
async function closePanel() {
  if (requestRecipient.value) { requestRecipient.value = null; return; }
  if (closing.value || composing) return;
  closing.value = true;
  try { if (await flushMetadata()) emit("close"); }
  finally { closing.value = false; }
}
function discardMetadata() {
  const row = profile.value;
  resetMetadata();
  if (row) bindMetadata(row);
}
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
    deferMedia: true,
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
async function showDirectory() {
  if (busy.value || closing.value) return;
  closing.value = true;
  try {
    if (!(await flushMetadata()) || disposed) return;
    resetMetadata();
    profile.value = null;
    profileError.value = "";
    profileSource.value = {};
    if (!directoryLoaded) void load();
  } finally { closing.value = false; }
}
async function openCommonGroup(id: number) {
  if (busy.value || closing.value) return;
  closing.value = true;
  try {
    if (!(await flushMetadata()) || disposed) return;
    await chat.choose(id);
    emit("close");
  } finally { closing.value = false; }
}
function directoryDetail(id: number) {
  const row = mode.value === "search" ? contacts.value.find(person => person.id === id) : undefined;
  void detail(id, false, row?.public_id ? { publicId: row.public_id } : {});
}
async function detail(id: number, revalidate = false, source: ProfileSource = profileSource.value) {
  if (busy.value && !revalidate) return;
  if (!revalidate && metadata && !(await flushMetadata())) return;
  const mine = ++revision;
  profileSource.value = source;
  profile.value = null;
  staffDetails.value = null;
  common.value = [];
  profileError.value = "";
  copied.value = "";
  busy.value = true;
  try {
    const result = await chat.api<Profile>(
      source.card
        ? `/contacts/card-profile?conversation_id=${source.card.conversation}&message_id=${source.card.message}`
        : "/contacts/profile?user_id=" +
            id +
            (source.publicId
              ? "&lookup_public_id=" + encodeURIComponent(source.publicId)
              : source.contextId ? "&context_conversation_id=" + source.contextId : ""),
    );
    if (mine !== revision) return;
    profile.value = result;
    bindMetadata(result);
    staffDetails.value = null;
    if (props.initialRequest && source.initial && !result.is_contact) {
      if (result.can_add_friend !== true) {
        profileError.value = result.add_friend_restriction || "当前无法添加该群成员";
      } else {
        requestRecipient.value = {
          id: result.id,
          name: result.remark || result.nickname,
          avatar: result.avatar_url,
          avatarId: result.avatar_id,
        };
      }
      return;
    }
    if (source.publicId && !result.is_contact) return;
    const commonResult = (
      await chat.api<Page<Conversation>>(
        "/contacts/common-groups?user_id=" +
          result.id +
          (source.contextId
            ? "&context_conversation_id=" + source.contextId
            : ""),
      )
    ).items;
    if (mine !== revision) return;
    common.value = commonResult;
    if (chat.me.value?.internal_staff) {
      const details = await chat.api<ContactAudit>(
        "/contacts/internal-profile?user_id=" +
          result.id +
          (source.contextId
            ? "&context_conversation_id=" + source.contextId
            : ""),
      );
      if (mine === revision && details.user_id === result.id && chat.me.value?.internal_staff === true && !chat.locked.value) staffDetails.value = details;
    }
  } catch (cause) {
    if (mine !== revision) return;
    const status = (cause as { status?: number }).status;
    if (status === 401 || status === 426) chat.error(cause);
    else if (!profile.value) { resetMetadata(); profileError.value = messageOf(cause); }
  } finally {
    if (mine === revision) busy.value = false;
  }
}
async function copyIdentity(key: "username" | "public_id") {
  const value = profile.value?.[key];
  if (!value || chat.locked.value) return;
  try {
    await navigator.clipboard.writeText(value);
    copied.value = key === "username" ? "已复制账号" : "已复制用户 ID";
  } catch (error) {
    chat.error(error);
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
      ...(profileSource.value.contextId ? { context_conversation_id: profileSource.value.contextId } : {}),
      ...(profileSource.value.card
        ? {
            card_conversation_id: profileSource.value.card.conversation,
            card_message_id: profileSource.value.card.message,
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
      avatarId: recipient.avatar_id,
    };
    return;
  }
  busy.value = true;
  try {
    if (profile.value?.id === target && !(await flushMetadata())) return;
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
    if (action === "accept" || action === "reject")
      await chat.post("/contact-requests/handle", {
        request_id: target,
        action,
      });
    if (action !== "chat") {
      resetMetadata();
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
watch(
  [() => chat.active.value?.membership_version, () => chat.active.value?.my_role],
  () => {
    if (props.userId && profileSource.value.contextId && chat.active.value?.id === profileSource.value.contextId &&
      (!profile.value || profile.value.id === props.userId))
      void detail(props.userId, true);
  },
);
if (props.userId || props.card) void detail(props.userId ?? 0);
else void load();
onScopeDispose(() => {
  disposed = true;
  const pending = metadata;
  metadata = undefined;
  if (pending) void pending.save.flush().finally(() => pending.save.stop());
  revision++;
  cancelList();
  abort.abort();
});
</script>
<template>
  <BaseDialog
    :title="requestRecipient ? '发送好友验证' : profile || profileError || ((userId || card) && busy && !directoryLoaded) ? '个人资料' : '联系人'"
    :size="profile || requestRecipient ? 'compact' : undefined"
    :layout="profile || requestRecipient ? undefined : 'contacts'"
    :busy="closing || (busy && !!requestRecipient)"
    @close="closePanel"
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
        :avatar-id="requestRecipient.avatarId"
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
    <p v-else-if="profileError" role="alert">{{ profileError }}</p>
    <p v-else-if="(userId || card) && busy && !profile && !directoryLoaded" role="status">正在加载资料…</p>
    <template v-else-if="profile">
      <div class="contact-profile">
      <button class="ui-text-button" :disabled="busy || closing" @click="showDirectory">返回联系人</button>
      <header class="contact-profile-head flex items-center gap-3">
        <AvatarImage :name="profile.nickname" :src="profile.avatar_url" :media-id="profile.avatar_id" />
        <h3>{{ profile.nickname }}</h3>
      </header>
      <p v-if="profile.add_friend_restriction" role="status">
        {{ profile.add_friend_restriction }}
      </p>
      <dl class="vue-details">
        <dt>账号</dt>
        <dd class="contact-profile-identity">
          <span>{{ profile.username || "未公开" }}</span>
          <button v-if="platform.name === 'pc' && profile.username" type="button" class="ui-icon-button" aria-label="复制账号" title="复制账号" @click="copyIdentity('username')"><UiIcon name="copy" /></button>
        </dd>
        <dt>用户 ID</dt>
        <dd class="contact-profile-identity">
          <span>{{ profile.public_id }}</span>
          <button v-if="platform.name === 'pc' && profile.public_id" type="button" class="ui-icon-button" aria-label="复制用户 ID" title="复制用户 ID" @click="copyIdentity('public_id')"><UiIcon name="copy" /></button>
        </dd>
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
      <p v-if="copied" role="status">{{ copied }}</p>
      <label>备注<input v-model="remark" aria-label="备注" maxlength="64"
        :disabled="!profile.is_contact || busy || closing"
        @input="metadataInput('remark', $event)" @blur="flushMetadata"
        @compositionstart="compositionStarted" @compositionend="compositionEnded('remark', $event)" /></label>
      <label>好友分组<input v-model="groupName" aria-label="好友分组" maxlength="64"
        :disabled="!profile.is_contact || busy || closing"
        @input="metadataInput('group_name', $event)" @blur="flushMetadata"
        @compositionstart="compositionStarted" @compositionend="compositionEnded('group_name', $event)" /></label>
      <p v-if="profile.is_contact && metadataState.phase === 'error'" class="contact-save-error" role="alert">
        自动保存失败：{{ messageOf(metadataState.error) }} 输入已保留。
        <button type="button" class="ui-text-button" :disabled="busy || closing" @click="flushMetadata">重试</button>
        <button type="button" class="ui-text-button" :disabled="busy || closing" @click="discardMetadata">放弃修改</button>
      </p>
      <p v-else-if="profile.is_contact" class="contact-save-status" role="status" aria-live="polite">{{ metadataState.phase === 'saving' ? '正在自动保存…' : metadataState.phase === 'waiting' ? '等待自动保存…' : metadataState.phase === 'saved' ? '已自动保存' : '' }}</p>
      <div class="vue-action-list contact-profile-actions">
        <button :disabled="busy || closing" @click="operation('chat', profile.id)">
          {{ profile.is_contact ? '发送消息' : '临时聊天' }}</button
        ><button
          v-if="!profile.is_contact"
          :disabled="busy || closing || profile.can_add_friend === false"
          @click="operation('request', profile.id)"
        >
          添加好友</button
        ><button
          v-if="chat.me.value?.internal_staff && !profile.is_contact"
          :disabled="busy || closing"
          @click="operation('force', profile.id)"
        >
          直接添加好友</button
        ><button
          v-if="profile.is_contact"
          :disabled="busy || closing"
          @click="operation('remove', profile.id)"
        >
          删除好友</button
        ><button
          :disabled="busy || closing"
          @click="
            operation(profile.blocked_by_me ? 'unblock' : 'block', profile.id)
          "
        >
          {{ profile.blocked_by_me ? "解除屏蔽" : "拉黑好友" }}
        </button>
      </div>
      <h4>共同群组</h4>
      <div class="contact-common-groups">
      <button
        v-for="group in common"
        :key="group.id"
        :disabled="busy || closing"
        @click="openCommonGroup(group.id)"
      >
        {{ group.name }}
      </button>
      </div>
      <ContactAuditDetails v-if="staffDetails && chat.me.value?.internal_staff" :details="staffDetails" />
      </div>
    </template>
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
      @profile="directoryDetail"
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
.contact-profile .contact-profile-actions.vue-action-list { display: flex; flex-wrap: nowrap; gap: 6px; }
.contact-profile .contact-profile-actions.vue-action-list > button { flex: 1 1 0; min-width: 0; padding-inline: 5px; white-space: nowrap; font-size: 12px; }
.contact-save-status { min-height: 17px; font-size: 12px; color: var(--ui-muted); margin: 3px 0 0; }
.contact-save-error .ui-text-button { margin-inline-start: 5px; font-size: 12px; }
.contact-common-groups { display: flex; flex-wrap: nowrap; gap: 6px; overflow-x: auto; padding-block: 2px 6px; scrollbar-width: thin; }
.contact-common-groups > button { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contact-profile-identity { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.contact-profile-identity span { overflow-wrap: anywhere; }
.contact-profile-identity .ui-icon-button { width: 26px; height: 26px; font-size: 15px; }
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
