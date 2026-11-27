<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onScopeDispose,
  shallowRef,
  useId,
  useTemplateRef,
  watch,
} from "vue";
import { chatKey } from "../../composables/useChat";
import BaseDialog from "../../components/BaseDialog.vue";
import ContextMenu from "../../components/ContextMenu.vue";
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
  fromGroup?: boolean;
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
type FriendRecipient = {
  id: number;
  name: string;
  avatar?: string;
  avatarId?: string;
  canAdd?: boolean;
  restriction?: string;
};
const requestRecipient = shallowRef<FriendRecipient | null>(null);
const requestNote = shallowRef("");
const requestError = shallowRef("");
const profileError = shallowRef("");
type ProfileSource = { publicId?: string; contextId?: number; card?: typeof props.card; initial?: boolean };
const profileSource = shallowRef<ProfileSource>({ contextId: props.contextId, card: props.card, initial: true });
// A group-opened self profile has a group origin, but intentionally no group authorization context.
const groupProfile = computed(() => (props.fromGroup && profileSource.value.initial) || !!profileSource.value.contextId ||
  (!!profileSource.value.card && chat.active.value?.type === "group" &&
    chat.active.value.id === profileSource.value.card.conversation));
const profileMenuId = useId();
const profileMenuTrigger = useTemplateRef<HTMLButtonElement>("profileMenuTrigger");
const profileMenuOpen = shallowRef(false);
const canManageContacts = computed(() => chat.me.value?.internal_staff === true);
type DestructiveAction = "remove" | "block";
type ProfileConfirmation = { action: DestructiveAction; target: number; name: string; token: string; revision: number };
const confirmation = shallowRef<ProfileConfirmation | null>(null);
const confirmationError = shallowRef("");
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
const profilePresence = computed(() => profile.value?.last_seen_hidden ? "最近上线已隐藏" : profile.value?.online ? "在线" : "离线");
const profilePresenceTitle = computed(() => !profile.value?.last_seen_hidden && !profile.value?.online && profile.value?.last_seen_at
  ? `最近在线：${profile.value.last_seen_at}` : profilePresence.value);
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
  if (confirmation.value) { if (!busy.value) cancelConfirmation(true); return; }
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
  profileMenuOpen.value = false;
  cancelConfirmation();
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
      await addFriend(friendRecipient(result), false, mine);
      return;
    }
    if (!result.is_contact) {
      const actor = chat.me.value?.id, token = chat.client.token;
      const me = await chat.api<Profile>("/auth/me", {
        authToken: token, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
      });
      if (disposed || mine !== revision || chat.locked.value || chat.client.token !== token || me.id !== actor) return;
      chat.me.value = me;
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
    else if (!profile.value || (props.initialRequest && source.initial)) { resetMetadata(); profileError.value = messageOf(cause); }
  } finally {
    if (mine === revision) busy.value = false;
  }
}
async function copyIdentity(key: "username" | "public_id" | "register_ip" | "last_login_ip") {
  const target = profile.value?.id, token = chat.client.token, mine = revision;
  const internal = key === "register_ip" || key === "last_login_ip";
  const value = internal
    ? chat.me.value?.internal_staff === true && staffDetails.value?.user_id === target ? staffDetails.value?.[key] : undefined
    : profile.value?.[key];
  if (!value || !target || disposed || chat.locked.value) return;
  const current = () => !disposed && !chat.locked.value && chat.client.token === token && mine === revision && profile.value?.id === target &&
    (!internal || chat.me.value?.internal_staff === true);
  try {
    await navigator.clipboard.writeText(value);
    if (current()) copied.value = { username: "已复制账号", public_id: "已复制用户 ID", register_ip: "已复制注册 IP 地址", last_login_ip: "已复制登录 IP 地址" }[key];
  } catch (error) {
    if (current()) chat.error(error);
  }
}
function friendRecipient(row: ContactEntry & Partial<Profile>): FriendRecipient {
  return {
    id: row.id, name: row.remark || row.nickname,
    avatar: row.avatar_url, avatarId: row.avatar_id,
    canAdd: row.can_add_friend, restriction: row.add_friend_restriction,
  };
}
async function addFriend(recipient: FriendRecipient, submit = false, mine = revision) {
  const token = chat.client.token, actor = chat.me.value?.id;
  const current = () => !disposed && !chat.locked.value && !closing.value &&
    revision === mine && chat.client.token === token && chat.me.value?.id === actor;
  if (!actor || recipient.id === actor || !current()) return;
  // The admin may have changed this privilege since this window was opened.
  // The force-add endpoint independently verifies it again within its transaction.
  const me = await chat.api<Profile>("/auth/me", {
    authToken: token, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
  }).catch(cause => { if (current()) throw cause; return null; });
  if (!me || !current()) return;
  if (me.id !== actor) throw Error("账号信息已变化，请重新打开联系人。");
  chat.me.value = me;
  const staff = me.internal_staff === true;
  if (!staff && !submit) {
    if (recipient.canAdd === false || (props.initialRequest && profileSource.value.initial && recipient.canAdd !== true)) {
      profileError.value = recipient.restriction || "当前无法添加该用户";
      return;
    }
    requestNote.value = "";
    requestError.value = "";
    requestRecipient.value = recipient;
    return;
  }
  const receipt = await chat.api<{ status?: string }>(staff ? "/contacts/force-add" : "/contact-requests", {
    method: "POST", authToken: token, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
    body: staff ? { user_id: recipient.id } : {
      to_user_id: recipient.id, message: requestNote.value,
      ...(profileSource.value.contextId ? { context_conversation_id: profileSource.value.contextId } : {}),
      ...(profileSource.value.card ? {
        card_conversation_id: profileSource.value.card.conversation,
        card_message_id: profileSource.value.card.message,
      } : {}),
    },
  }).catch(cause => { if (current()) throw cause; return null; });
  if (!receipt || !current()) return;
  requestRecipient.value = null;
  resetMetadata();
  profile.value = null;
  notice.value = staff || receipt.status === "accepted" ? "已添加为好友" : "好友申请已发送";
  await load();
  if (!current()) return;
  void chat.loadDirectory();
  void chat.refreshNames();
  void chat.refreshNotificationCount();
}
async function submitFriendRequest() {
  const recipient = requestRecipient.value;
  if (!recipient || busy.value) return;
  busy.value = true;
  requestError.value = "";
  try {
    await addFriend(recipient, true);
  } catch (cause) {
    const status = (cause as { status?: number } | null)?.status;
    if (status === 401 || status === 426) chat.error(cause);
    else requestError.value = messageOf(cause);
  } finally {
    busy.value = false;
  }
}
async function operation(action: string, target: number) {
  if (busy.value || closing.value || confirmation.value || disposed || chat.locked.value) return;
  if (action === "remove" || action === "block") {
    requestConfirmation(action, target);
    return;
  }
  const recipient = action === "request" ? profile.value ?? contacts.value.find((row) => row.id === target) : null;
  if (action === "request" && (!recipient || recipient.id !== target)) return;
  if (recipient?.is_contact === true) action = "chat";
  busy.value = true;
  try {
    if (recipient && action === "request") { await addFriend(friendRecipient(recipient)); return; }
    if (profile.value?.id === target && !(await flushMetadata())) return;
    if (action === "chat") {
      const row = await chat.post<Conversation>("/conversations/direct", {
        user_id: target,
      });
      await chat.choose(row.id);
      emit("close");
    }
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
function cancelConfirmation(restoreFocus = false) {
  const target = confirmation.value?.target;
  confirmation.value = null;
  confirmationError.value = "";
  if (restoreFocus) void nextTick(() => {
    const trigger = profileMenuTrigger.value;
    if (!disposed && !confirmation.value && !chat.locked.value && profile.value?.id === target &&
        !profileError.value && !requestRecipient.value && trigger?.isConnected && !trigger.disabled)
      trigger.focus({ preventScroll: true });
  });
}
function requestConfirmation(action: DestructiveAction, target: number) {
  const row = profile.value;
  if (!canManageContacts.value || !row || row.id !== target || target === chat.me.value?.id ||
      (action === "remove" ? !row.is_contact : row.blocked_by_me)) return;
  profileMenuOpen.value = false;
  confirmationError.value = "";
  confirmation.value = {
    action, target, name: row.remark || row.nickname,
    token: chat.client.token, revision,
  };
}
async function confirmOperation() {
  const intent = confirmation.value;
  if (!intent || busy.value || closing.value) return;
  const current = () => !disposed && confirmation.value === intent &&
    canManageContacts.value && chat.client.token === intent.token && !chat.locked.value && revision === intent.revision &&
    profile.value?.id === intent.target && intent.target !== chat.me.value?.id &&
    (intent.action === "remove" ? profile.value.is_contact : !profile.value.blocked_by_me);
  if (!current()) { cancelConfirmation(); return; }
  busy.value = true;
  confirmationError.value = "";
  try {
    const saved = await flushMetadata();
    if (!current()) return;
    if (!saved) {
      confirmationError.value = "请先处理资料页中的备注保存问题，再重试。";
      return;
    }
    await chat.post(intent.action === "remove" ? "/contacts/remove" : "/blocks", {
      user_id: intent.target,
      ...(intent.action === "block" ? { reason: "用户操作" } : {}),
    });
    if (!current()) return;
    cancelConfirmation();
    resetMetadata();
    profile.value = null;
    if (directoryLoaded) await load();
    else emit("close");
    void chat.loadDirectory();
    void chat.refreshNames();
    void chat.refreshNotificationCount();
  } catch (cause) {
    if (!current()) return;
    confirmationError.value = messageOf(cause);
    if ([401, 426].includes((cause as { status?: number }).status ?? 0)) chat.error(cause);
  } finally {
    if (!disposed && revision === intent.revision) busy.value = false;
  }
}
watch([() => profile.value?.id, chat.locked, canManageContacts], () => {
  profileMenuOpen.value = false;
  if (!profile.value || chat.locked.value || !canManageContacts.value) cancelConfirmation();
});
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
    :layout="requestRecipient ? undefined : profile ? 'contact-profile' : 'contacts'"
    :busy="closing || (busy && !!(requestRecipient || confirmation))"
    @close="closePanel"
  >
    <template #header-actions>
      <button
        v-if="profile && !profileError && !requestRecipient && profile.id !== chat.me.value?.id && (canManageContacts || profile.blocked_by_me)"
        ref="profileMenuTrigger"
        type="button"
        class="ui-icon-button profile-more-button"
        aria-label="更多资料操作"
        title="更多"
        aria-haspopup="menu"
        :aria-expanded="profileMenuOpen"
        :aria-controls="profileMenuId"
        :disabled="busy || closing || !!confirmation"
        @mousedown.left.prevent
        @click="profileMenuOpen = !profileMenuOpen"
      ><UiIcon name="more" /></button>
    </template>
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
      <button v-if="!groupProfile" class="ui-text-button" :disabled="busy || closing" @click="showDirectory">返回联系人</button>
      <header class="contact-profile-head">
        <AvatarImage :name="profile.nickname" :src="profile.avatar_url" :media-id="profile.avatar_id" />
        <div class="contact-profile-heading">
          <h3>{{ profile.nickname }}</h3>
          <span class="contact-profile-presence" :data-state="profile.last_seen_hidden ? 'hidden' : profile.online ? 'online' : 'offline'" :title="profilePresenceTitle" role="status"><span aria-hidden="true" />{{ profilePresence }}</span>
        </div>
      </header>
      <p v-if="profile.add_friend_restriction" role="status">
        {{ profile.add_friend_restriction }}
      </p>
      <label class="contact-profile-field">备注<input v-model="remark" aria-label="备注" maxlength="64"
        :disabled="!profile.is_contact || busy || closing"
        @input="metadataInput('remark', $event)" @blur="flushMetadata"
        @compositionstart="compositionStarted" @compositionend="compositionEnded('remark', $event)" /></label>
      <dl class="contact-profile-details">
        <dt>账号</dt>
        <dd class="contact-profile-identity">
          <span>{{ profile.username || "未公开" }}</span>
          <button v-if="profile.username" type="button" class="ui-icon-button" aria-label="复制账号" title="复制账号" :disabled="chat.locked.value" @click="copyIdentity('username')"><UiIcon name="copy" /></button>
        </dd>
        <dt>用户 ID</dt>
        <dd class="contact-profile-identity">
          <span>{{ profile.public_id }}</span>
          <button v-if="profile.public_id" type="button" class="ui-icon-button" aria-label="复制用户 ID" title="复制用户 ID" :disabled="chat.locked.value" @click="copyIdentity('public_id')"><UiIcon name="copy" /></button>
        </dd>
      </dl>
      <label class="contact-profile-field">好友分组<input v-model="groupName" aria-label="好友分组" maxlength="64"
        :disabled="!profile.is_contact || busy || closing"
        @input="metadataInput('group_name', $event)" @blur="flushMetadata"
        @compositionstart="compositionStarted" @compositionend="compositionEnded('group_name', $event)" /></label>
      <p v-if="profile.is_contact && metadataState.phase === 'error'" class="contact-save-error" role="alert">
        自动保存失败：{{ messageOf(metadataState.error) }} 输入已保留。
        <button type="button" class="ui-text-button" :disabled="busy || closing" @click="flushMetadata">重试</button>
        <button type="button" class="ui-text-button" :disabled="busy || closing" @click="discardMetadata">放弃修改</button>
      </p>
      <p v-else-if="profile.is_contact" class="contact-save-status" role="status" aria-live="polite">{{ metadataState.phase === 'saving' ? '正在自动保存…' : metadataState.phase === 'waiting' ? '等待自动保存…' : metadataState.phase === 'saved' ? '已自动保存' : '' }}</p>
      <ContactAuditDetails v-if="staffDetails && staffDetails.user_id === profile.id && chat.me.value?.internal_staff && !chat.locked.value" :details="staffDetails" :disabled="busy || closing" @copy="copyIdentity" />
      <p v-if="copied" class="contact-copy-status" role="status">{{ copied }}</p>
      <dl v-if="profile.signature" class="contact-profile-details contact-profile-signature"><dt>个性签名</dt><dd>{{ profile.signature }}</dd></dl>
      <section v-if="common.length" class="contact-common-section" aria-label="共同群组">
        <h4>共同群组</h4>
        <div class="contact-common-groups">
          <button v-for="group in common" :key="group.id" :disabled="busy || closing" @click="openCommonGroup(group.id)">{{ group.name }}</button>
        </div>
      </section>
      <details class="contact-profile-extra"><summary>更多资料</summary><dl class="contact-profile-details"><dt>数字 ID</dt><dd>{{ profile.id }}</dd></dl></details>
      <div v-if="!profile.is_contact" class="vue-action-list contact-profile-secondary-actions">
        <button
          v-if="!profile.is_contact"
          :disabled="busy || closing || (profile.can_add_friend === false && !chat.me.value?.internal_staff)"
          @click="operation('request', profile.id)"
        >
          添加好友
        </button>
      </div>
      <ContextMenu
        v-if="profileMenuOpen && !confirmation"
        :id="profileMenuId"
        compact
        label="个人资料操作"
        :anchor="profileMenuTrigger || undefined"
        @close="profileMenuOpen = false"
      >
        <button v-if="canManageContacts || profile.blocked_by_me" role="menuitem" :disabled="busy || closing" @click="profileMenuOpen = false; operation(profile.blocked_by_me ? 'unblock' : 'block', profile.id)"><UiIcon name="shield" />{{ profile.blocked_by_me ? '解除屏蔽' : '拉黑好友' }}</button>
        <button v-if="canManageContacts && profile.is_contact" role="menuitem" :disabled="busy || closing" @click="operation('remove', profile.id)"><UiIcon name="delete" />删除好友</button>
      </ContextMenu>
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
    <template v-if="requestRecipient || (profile && !profileError)" #footer>
      <div v-if="profile && !requestRecipient" class="contact-profile-actions">
        <button type="button" class="primary" :disabled="busy || closing || chat.locked.value" @click="operation('chat', profile.id)">{{ profile.is_contact ? '发送消息' : '临时聊天' }}</button>
      </div>
      <template v-else>
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
    </template>
  </BaseDialog>
  <BaseDialog
    v-if="confirmation"
    :title="confirmation.action === 'remove' ? '删除好友' : '拉黑好友'"
    size="compact"
    :busy="busy"
    @close="!busy && cancelConfirmation(true)"
  >
    <p>确定{{ confirmation.action === 'remove' ? '删除好友' : '拉黑' }}「{{ confirmation.name }}」吗？</p>
    <p v-if="confirmationError" role="alert">{{ confirmationError }}</p>
    <template #footer>
      <button type="button" data-dialog-autofocus :disabled="busy" @click="cancelConfirmation(true)">取消</button>
      <button type="button" class="vue-button-danger" :disabled="busy" @click="confirmOperation">{{ busy ? '处理中…' : confirmation.action === 'remove' ? '确定删除' : '确定拉黑' }}</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.profile-more-button { font-size: 20px; }
.contact-profile { display: flex; flex-direction: column; gap: 12px; }
.contact-profile > .ui-text-button { align-self: flex-start; padding: 0; }
.contact-profile-actions { width: 100%; }
.contact-profile-actions > button { width: 100%; min-height: 44px; font-size: 16px; }
.contact-profile .contact-profile-field { display: grid; gap: 6px; margin: 0; }
.contact-profile .contact-profile-field input { width: 100%; min-width: 0; min-height: 34px; }
.contact-profile .contact-profile-secondary-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.contact-profile-secondary-actions > button { flex: 1; min-width: 0; }
.contact-profile-details { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 8px 14px; font-size: 13px; }
.contact-profile-details dt { color: var(--ui-muted); }
.contact-profile-details dd { min-width: 0; text-align: end; overflow-wrap: anywhere; }
.contact-profile-signature { padding-top: 10px; border-top: 1px solid var(--ui-line); }
.contact-profile-extra { font-size: 12px; color: var(--ui-muted); }
.contact-profile-extra summary { cursor: pointer; }
.contact-profile-extra dl { margin-top: 10px; }
.contact-copy-status { font-size: 12px; color: var(--ui-primary); }
.contact-common-section h4 { margin-bottom: 6px; font-size: 13px; }
.contact-save-status { min-height: 17px; font-size: 12px; color: var(--ui-muted); margin: -6px 0 0; }
.contact-save-error .ui-text-button { margin-inline-start: 5px; font-size: 12px; }
.contact-common-groups { display: flex; flex-wrap: nowrap; gap: 6px; overflow-x: auto; padding-block: 2px 6px; scrollbar-width: thin; }
.contact-common-groups > button { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contact-profile-identity { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
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
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 3px 0 12px;
  border-bottom: 1px solid var(--ui-line);
}
.contact-profile-head .avatar {
  --avatar-size: 48px;
}
.contact-profile-head h3 {
  margin: 0;
  font-size: 17px;
}
.contact-profile-heading { display: flex; flex: 1; min-width: 0; align-items: center; flex-wrap: wrap; gap: 5px 12px; }
.contact-profile-heading h3 { min-width: 0; overflow-wrap: anywhere; }
.contact-profile-presence { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ui-muted); }
.contact-profile-presence > span { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--ui-text); }
.contact-profile-presence[data-state="online"] { color: var(--ui-success); }
.contact-profile-presence[data-state="online"] > span { background: var(--ui-success); }
.contact-profile-presence[data-state="hidden"] > span { background: var(--ui-muted); }
</style>
