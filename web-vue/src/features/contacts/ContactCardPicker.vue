<script setup lang="ts">
import { computed, inject, onScopeDispose, shallowRef, watch } from "vue";
import AvatarImage from "../../components/AvatarImage.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { chatKey } from "../../composables/useChat";
import { messageOf } from "../../api/client";
import type { Message, Page, Profile } from "../../api/types";

const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const client = chat.client, token = client.token, source = chat.active.value?.id, owner = chat.me.value?.id;
const lifetime = new AbortController();
const current = () => !lifetime.signal.aborted && client.token === token && chat.me.value?.id === owner &&
  chat.active.value?.id === source && chat.canSend.value && !chat.updateSuspended.value;
const contacts = shallowRef<Profile[]>([]), found = shallowRef<Profile[]>([]);
const query = shallowRef(""), loading = shallowRef(false), looking = shallowRef(false), sending = shallowRef<number>();
const loadError = shallowRef(""), searchError = shallowRef(""), sendError = shallowRef("");
const total = shallowRef<number>(), complete = shallowRef(false);
const busy = computed(() => sending.value !== undefined);
const requestIds = new Map<number, string>();
let nextPage = 1, lookup: AbortController | undefined;
const terms = computed(() => query.value.trim().toLowerCase().split(/\s+/).filter(Boolean).map(term => term.replace(/^@/, "")));
const rows = computed(() => {
  const matching = contacts.value.filter(row => {
    const text = [row.remark, row.nickname, row.username, row.public_id].filter(Boolean).join(" ").toLowerCase();
    return terms.value.every(term => text.includes(term));
  });
  return [...new Map([...found.value, ...matching].map(row => [row.id, row])).values()];
});
watch(query, () => { lookup?.abort(); lookup = undefined; looking.value = false; found.value = []; searchError.value = ""; }, { flush: "sync" });
watch([() => chat.active.value?.id, chat.canSend, chat.updateSuspended, () => chat.me.value?.id], () => {
  if (!current()) { lifetime.abort(); emit("close"); }
}, { flush: "sync" });
function signal(request?: AbortController) {
  return AbortSignal.any([lifetime.signal, ...(request ? [request.signal] : []), AbortSignal.timeout(15000)]);
}
function showError(cause: unknown) {
  if ([401, 426].includes((cause as { status?: number })?.status || 0)) chat.error(cause);
  return messageOf(cause);
}
async function load() {
  if (!current() || loading.value || complete.value) return;
  loading.value = true; loadError.value = "";
  try {
    while (current() && !complete.value) {
      const result = await chat.api<Page<Profile>>(`/contacts?page=${nextPage}&size=100`, {
        authToken: token, signal: signal(), deferMedia: true,
      });
      if (!current()) return;
      const merged = [...new Map([...contacts.value, ...result.items].map(row => [row.id, row])).values()];
      const more = typeof result.has_more === "boolean" ? result.has_more :
        result.total != null ? merged.length < result.total : result.items.length === 100;
      if (more && (!result.items.length || merged.length === contacts.value.length)) throw new Error("联系人分页未能继续，请重试。");
      contacts.value = merged;
      if (Number.isSafeInteger(result.total) && result.total! >= 0) total.value = result.total;
      complete.value = !more;
      nextPage++;
    }
  } catch (cause) {
    if (current()) loadError.value = showError(cause);
  } finally { loading.value = false; }
}
async function findAccount() {
  if (!current() || busy.value || loading.value || looking.value) return;
  const account = query.value.trim().replace(/^@/, "");
  if (!account) return;
  if (/\s/.test(account)) { searchError.value = "多个关键词用于筛选联系人；按账号查找时请输入完整账号。"; return; }
  lookup?.abort();
  const request = lookup = new AbortController();
  looking.value = true; found.value = []; searchError.value = "";
  try {
    const options = { authToken: token, signal: signal(request), deferMedia: true };
    let result = await chat.api<Page<Profile>>("/contacts/search?q=" + encodeURIComponent(account), options);
    if (!result.items.length && /^([A-Za-z0-9]{16}|[A-F0-9]{32})$/.test(account))
      result = await chat.api<Page<Profile>>("/contacts/search?public_id=" + encodeURIComponent(account), options);
    if (!current() || request.signal.aborted || lookup !== request) return;
    found.value = result.items;
    if (!result.items.length) searchError.value = "未找到该账号，请检查后重试。";
  } catch (cause) {
    if (current() && !request.signal.aborted && lookup === request) searchError.value = showError(cause);
  } finally { if (lookup === request) looking.value = false; }
}
async function send(row: Profile) {
  if (!current() || busy.value || !source || !Number.isSafeInteger(row.id) || row.id < 1) return;
  sending.value = row.id; sendError.value = "";
  if (!requestIds.has(row.id)) requestIds.set(row.id, "card-" + crypto.randomUUID());
  try {
    const sent = await chat.api<Message>("/messages", {
      method: "POST", authToken: token, signal: signal(), deferMedia: true,
      body: { conversation_id: source, type: "contact_card", body: { user_id: row.id }, request_id: requestIds.get(row.id) },
    });
    if (!current()) return;
    if (sent.conversation_id !== source) throw new Error("服务器返回的名片会话不匹配，请重试。");
    chat.mergeMessages([sent]); chat.sendRevision.value++; emit("close");
  } catch (cause) {
    if (current()) sendError.value = showError(cause);
  } finally { sending.value = undefined; }
}
void load();
onScopeDispose(() => { lifetime.abort(); lookup?.abort(); });
</script>

<template>
  <BaseDialog title="发送站内名片" layout="contact-card-picker" :busy="busy" @close="emit('close')">
    <div class="contact-card-picker">
      <form class="contact-card-toolbar" @submit.prevent="findAccount">
        <input v-model="query" class="contact-card-search" type="search" aria-label="搜索名片联系人"
          placeholder="搜索备注/昵称/账号/ID，空格分隔关键词" maxlength="100" data-dialog-autofocus :disabled="busy" />
        <button type="submit" class="ui-text-button contact-card-lookup" title="按完整账号或用户 ID 查找"
          :disabled="busy || loading || looking || !query.trim()">{{ looking ? '查找中…' : '查找账号' }}</button>
      </form>
      <div class="contact-card-count" role="status" aria-live="polite">
        共 {{ total ?? contacts.length }} 位联系人{{ total == null && !complete ? '+' : '' }}<span v-if="terms.length"> · 找到 {{ rows.length }} 位</span>
      </div>
      <div class="contact-card-scroll" :aria-busy="loading || looking">
        <ul v-if="rows.length" class="contact-card-list" aria-label="名片联系人">
          <li v-for="row in rows" :key="row.id" class="contact-card-row">
            <button type="button" class="contact-card-select" :disabled="busy" :aria-busy="sending === row.id"
              :aria-label="'发送 ' + (row.remark || row.nickname || row.username) + ' 的名片'" @click="send(row)">
              <AvatarImage :name="row.remark || row.nickname || row.username" :src="row.avatar_url" :media-id="row.avatar_id" />
              <span class="contact-card-person">
                <strong :title="row.remark || row.nickname || row.username">{{ row.remark || row.nickname || row.username }}</strong>
                <span v-if="row.remark && row.nickname && row.remark !== row.nickname" :title="row.nickname">昵称：{{ row.nickname }}</span>
                <span v-if="row.username" :title="'@' + row.username">@{{ row.username }}</span>
                <small v-if="row.public_id" :title="row.public_id">ID：{{ row.public_id }}</small>
              </span>
              <span class="contact-card-send" aria-hidden="true">{{ sending === row.id ? '发送中…' : '发送' }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="!loading && !looking && !loadError" class="contact-card-empty">{{ query.trim() ? '暂无匹配联系人，可按完整账号查找' : '暂无联系人，可输入账号查找' }}</p>
        <p v-if="loading" class="contact-card-loading" role="status">正在加载联系人…</p>
        <p v-if="loadError" class="contact-card-load-error" role="alert">部分联系人未加载：{{ loadError }} <button type="button" class="ui-text-button" :disabled="busy" @click="load">重试加载</button></p>
      </div>
      <p v-if="searchError" class="contact-card-error" role="status">{{ searchError }}</p>
      <p v-if="sendError" class="contact-card-error" role="alert">发送失败：{{ sendError }}。可点击同一用户重试。</p>
    </div>
  </BaseDialog>
</template>

<style scoped>
.contact-card-picker { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.contact-card-picker .contact-card-toolbar { display: flex; flex: none; align-items: center; gap: 5px; }
.contact-card-picker .contact-card-toolbar .contact-card-search { flex: 1; min-width: 0; min-height: 39px; border-radius: 6px; background: var(--ui-surface); font-size: 12px; padding-inline: 9px; }
.contact-card-toolbar .contact-card-lookup { flex: none; padding-inline: 5px; font-size: 12px; }
.contact-card-count { flex: none; padding: 8px 0; color: var(--ui-muted); font-size: 11px; }
.contact-card-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-width: thin; overscroll-behavior: contain; }
.contact-card-list { margin: 0; padding: 0; list-style: none; }
.contact-card-picker .contact-card-list .contact-card-select { display: grid; width: 100%; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 11px; min-height: 83px; padding: 9px 5px; border: 0; border-bottom: 1px solid var(--ui-line); border-radius: 0; background: transparent; color: var(--ui-text); text-align: start; font: inherit; cursor: pointer; }
.contact-card-select:not(:disabled):hover { background: var(--ui-surface-soft); }
.contact-card-select:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
.contact-card-select:disabled { cursor: default; }
.contact-card-row .avatar { --avatar-size: 40px; --avatar-radius: 5px; }
.contact-card-person { display: grid; gap: 3px; min-width: 0; }
.contact-card-person > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contact-card-person strong { font-size: 14px; font-weight: 600; }
.contact-card-person > span { color: var(--ui-muted); font-size: 11px; }
.contact-card-person small { color: var(--ui-muted); font-size: 10px; }
.contact-card-row .contact-card-send { min-width: 39px; padding: 5px; color: var(--ui-primary); font-size: 12px; }
.contact-card-empty { padding: 25px 8px; color: var(--ui-muted); text-align: center; font-size: 12px; }
.contact-card-loading { padding: 9px 5px; color: var(--ui-muted); font-size: 12px; }
.contact-card-load-error, .contact-card-error { flex: none; font-size: 12px; }
.contact-card-error { margin: 8px 0 0; color: var(--ui-danger); }
@media (max-width: 480px) {
  .contact-card-picker .contact-card-list .contact-card-select { gap: 8px; }
  .contact-card-picker .contact-card-toolbar .contact-card-search { font-size: 11px; }
}
</style>
