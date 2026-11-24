<script setup lang="ts">
import { computed, inject, onScopeDispose, shallowRef, watch } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { chatKey } from "../../composables/useChat";
import { messageOf } from "../../api/client";
import type { History, Message, Page, Member } from "../../api/types";

const props = defineProps<{ conversationOnly?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const source = chat.active.value;
const lifetime = new AbortController();
const firstDate = shallowRef("");
const today = shallowRef(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }));
const memberQuery = shallowRef("");
const members = shallowRef<Pick<Member, "id" | "nickname">[]>([]);
const memberPage = shallowRef(1);
const memberMore = shallowRef(false);
const memberBusy = shallowRef(false);
const keyword = shallowRef("");
const date = shallowRef("");
const sender = shallowRef("");
const kind = shallowRef("");
const scope = shallowRef(true);
const items = shallowRef<Message[]>([]);
const nextBefore = shallowRef("");
const searched = shallowRef(false);
const busy = shallowRef(false);
const error = shallowRef("");
let searchRequest: AbortController | undefined;
let rosterRequest: AbortController | undefined;
let rosterTimer: ReturnType<typeof setTimeout> | undefined;
let locating = false;

const options = (signal: AbortSignal, timeout = 15_000) => ({
  signal: AbortSignal.any([lifetime.signal, signal, AbortSignal.timeout(timeout)]),
});
const query = computed(() => {
  const params = new URLSearchParams({ q: keyword.value.trim(), size: "30" });
  if ((props.conversationOnly || scope.value) && source) params.set("conversation_id", String(source.id));
  if (date.value) params.set("date", date.value);
  if (sender.value) params.set("sender_id", sender.value);
  if (kind.value) params.set("type", kind.value);
  return params;
});
watch(() => chat.active.value?.id, (id) => {
  if (id !== source?.id) emit("close");
});
watch(query, () => {
  searchRequest?.abort();
  searchRequest = undefined;
  items.value = [];
  nextBefore.value = "";
  searched.value = false;
  busy.value = false;
  error.value = "";
}, { flush: "sync" });

async function search(more = false) {
  if (busy.value || (more && !nextBefore.value)) return;
  const request = new AbortController();
  searchRequest = request;
  busy.value = true;
  error.value = "";
  const params = new URLSearchParams(query.value);
  if (more) params.set("before_id", nextBefore.value);
  try {
    const result = await chat.api<Page<Message>>("/messages/search?" + params, {
      ...options(request.signal, 20_000),
      deferMedia: true,
    });
    if (searchRequest !== request || lifetime.signal.aborted) return;
    items.value = more ? [...items.value, ...result.items] : result.items;
    nextBefore.value = result.next_before || "";
    searched.value = true;
  } catch (cause) {
    if (searchRequest !== request || lifetime.signal.aborted) return;
    const status = (cause as { status?: number } | null)?.status;
    if (status === 401 || status === 426) chat.error(cause);
    else error.value = messageOf(cause);
  } finally {
    if (searchRequest === request) busy.value = false;
  }
}

async function calendar() {
  if (!source) return;
  try {
    const result = await chat.api<{ today: string; first_date: string }>(
      "/messages/calendar?conversation_id=" + source.id, options(lifetime.signal),
    );
    if (!lifetime.signal.aborted) {
      firstDate.value = result.first_date;
      today.value = result.today;
    }
  } catch (cause) {
    if (!lifetime.signal.aborted && [401, 426].includes((cause as { status?: number } | null)?.status || 0)) chat.error(cause);
  }
}

async function loadMembers(more = false) {
  if (!source || source.type !== "group") return;
  if (more && memberBusy.value) return;
  rosterRequest?.abort();
  const request = new AbortController();
  rosterRequest = request;
  const page = more ? memberPage.value + 1 : 1;
  const params = new URLSearchParams({
    conversation_id: String(source.id), q: memberQuery.value.trim(), page: String(page),
  });
  memberBusy.value = true;
  try {
    const result = await chat.api<Page<Member>>("/conversations/members?" + params, options(request.signal));
    if (rosterRequest !== request || lifetime.signal.aborted) return;
    const selected = members.value.find(member => String(member.id) === sender.value);
    const combined = more ? [...members.value, ...result.items] : result.items;
    members.value = selected && !combined.some(row => row.id === selected.id) ? [selected, ...combined] : combined;
    memberPage.value = page;
    memberMore.value = result.has_more === true;
  } catch (cause) {
    if (rosterRequest === request && !lifetime.signal.aborted) chat.error(cause);
  } finally {
    if (rosterRequest === request) memberBusy.value = false;
  }
}
watch(memberQuery, () => {
  rosterRequest?.abort();
  rosterRequest = undefined;
  memberBusy.value = true;
  memberMore.value = false;
  clearTimeout(rosterTimer);
  rosterTimer = setTimeout(() => { void loadMembers(); }, 240);
}, { flush: "sync" });

async function locate(message: Message) {
  if (locating) return;
  locating = true;
  try {
    await chat.locate(message);
    if (!lifetime.signal.aborted) emit("close");
  } catch (cause) {
    if (!lifetime.signal.aborted) chat.error(cause);
  } finally {
    locating = false;
  }
}
async function oldest() {
  if (!source || locating) return;
  locating = true;
  try {
    const result = await chat.api<History>(
      "/messages/locate?conversation_id=" + source.id + "&first=1", options(lifetime.signal),
    );
    if (lifetime.signal.aborted || chat.active.value?.id !== source.id) return;
    if (!result.items.length) {
      error.value = "没有可定位的聊天记录。";
      return;
    }
    chat.mergeMessages(result.items, true);
    chat.located.value = result.items[0]?.id || null;
    emit("close");
  } catch (cause) {
    if (!lifetime.signal.aborted) chat.error(cause);
  } finally {
    locating = false;
  }
}

if (source?.type === "direct") {
  if (chat.me.value) members.value = [{ id: chat.me.value.id, nickname: "我" }];
  if (source.peer_user_id) members.value = [...members.value, { id: source.peer_user_id, nickname: source.name }];
} else {
  void loadMembers();
}
void calendar();
onScopeDispose(() => {
  lifetime.abort();
  clearTimeout(rosterTimer);
});
</script>
<template>
  <BaseDialog title="搜索聊天记录" size="wide" @close="emit('close')"
    ><form class="vue-fields vue-history-search" @submit.prevent="search()">
      <input
        v-model="keyword"
        data-dialog-autofocus
        aria-label="搜索消息"
        placeholder="搜索消息"
      /><label v-if="!conversationOnly"><input v-model="scope" type="checkbox" />仅当前会话</label
      ><label
        >日期<input
          v-model="date"
          aria-label="筛选日期"
          type="date"
          :min="firstDate || undefined"
          :max="today" /></label
      ><label v-if="chat.active.value?.type === 'group'"
        >搜索发送者<input v-model="memberQuery" /></label
      ><button
        v-if="memberMore"
        type="button"
        :disabled="memberBusy"
        @click="loadMembers(true)"
      >
        更多发送者</button
      ><label
        >发送者<select v-model="sender" aria-label="筛选发送者">
          <option value="">所有人</option>
          <option v-for="member in members" :key="member.id" :value="member.id">
            {{ member.nickname }}
          </option>
        </select></label
      ><label
        >消息类型<select v-model="kind">
          <option value="">全部</option>
          <option value="text">文字</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="file">文件</option>
          <option value="voice">语音</option>
          <option value="contact_card">名片</option>
        </select></label
      >
      <div class="vue-history-search-actions">
        <button type="button" @click="oldest">定位最早消息</button>
        <button class="primary" :disabled="busy">搜索</button>
      </div>
    </form>
    <div class="vue-search-results" :aria-busy="busy">
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-else-if="searched && !items.length && !busy" role="status">未找到匹配消息</p>
      <button
        v-for="message in items"
        :key="message.conversation_id + ':' + message.id"
        @click="locate(message)"
      >
        <strong>{{ message.sender_name }}</strong><time>{{
          message.created_at
        }}</time>
        <p>{{ message.body.name || chat.messagePreview(message) }}</p></button
      ><button
        v-if="nextBefore"
        :disabled="busy"
        @click="search(true)"
      >
        加载更多
      </button>
    </div></BaseDialog
  >
</template>

<style scoped>
.vue-history-search {
  padding: 12px;
  border: 1px solid var(--ui-line);
  border-radius: 7px;
  background: var(--ui-surface-soft);
}
.vue-search-results {
  display: grid;
  gap: 6px;
  margin-top: 12px;
}
.vue-search-results button {
  display: block;
  text-align: start;
  width: 100%;
  padding: 10px 12px;
  background: var(--ui-surface-soft);
  border: 1px solid var(--ui-line);
}
.vue-search-results time {
  float: inline-end;
  margin-inline-start: 6px;
  font-size: 11px;
  color: var(--ui-muted);
}
.vue-search-results p {
  margin: 4px 0 0;
  white-space: pre-wrap;
}
.vue-history-search-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 6px;
}
@media (min-width: 601px) {
  .vue-history-search {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .vue-history-search > input,
  .vue-history-search-actions {
    grid-column: 1 / -1;
  }
}
</style>
