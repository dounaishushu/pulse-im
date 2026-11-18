<script setup lang="ts">
import { inject, onScopeDispose, shallowRef, watch } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { chatKey } from "../../composables/useChat";
import type { History, Message, Page, Member } from "../../api/types";
import { textOf } from "../../api/types";
const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const controller = new AbortController(),
  source = chat.active.value?.id;
let revision = 0,
  rosterRevision = 0;
const firstDate = shallowRef(""),
  today = shallowRef(
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
  ),
  memberQuery = shallowRef(""),
  memberPage = shallowRef(1),
  memberMore = shallowRef(false);
watch(
  () => chat.active.value?.id,
  (id) => {
    if (id !== source) emit("close");
  },
);
const keyword = shallowRef(""),
  date = shallowRef(""),
  sender = shallowRef(""),
  kind = shallowRef(""),
  scope = shallowRef(true);
const items = shallowRef<Message[]>([]),
  members = shallowRef<Member[]>([]),
  page = shallowRef(1),
  hasMore = shallowRef(false),
  busy = shallowRef(false);
async function search(more = false) {
  if (busy.value) return;
  const mine = ++revision;
  busy.value = true;
  if (!more) page.value = 1;
  try {
    const query = new URLSearchParams({
      q: keyword.value.trim(),
      page: String(page.value),
      size: "30",
    });
    if (scope.value && chat.active.value)
      query.set("conversation_id", String(chat.active.value.id));
    if (date.value) query.set("date", date.value);
    if (sender.value) query.set("sender_id", sender.value);
    if (kind.value) query.set("type", kind.value);
    const result = await chat.api<Page<Message>>("/messages/search?" + query, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    });
    if (controller.signal.aborted || mine !== revision) return;
    items.value = more ? [...items.value, ...result.items] : result.items;
    hasMore.value = !!result.next_before;
  } catch (cause) {
    chat.error(cause);
  } finally {
    busy.value = false;
  }
}
async function calendar() {
  if (!source) return;
  try {
    const result = await chat.api<{ today: string; first_date: string }>(
      "/messages/calendar?conversation_id=" + source,
    );
    if (!controller.signal.aborted) {
      firstDate.value = result.first_date;
      today.value = result.today;
    }
  } catch (cause) {
    if (!controller.signal.aborted) chat.error(cause);
  }
}
async function loadMembers(more = false) {
  if (!source || chat.active.value?.type !== "group") return;
  const mine = ++rosterRevision;
  if (!more) memberPage.value = 1;
  try {
    const result = await chat.api<Page<Member>>(
      `/conversations/members?conversation_id=${source}&q=${encodeURIComponent(memberQuery.value)}&page=${memberPage.value}`,
      {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
      },
    );
    if (!controller.signal.aborted && mine === rosterRevision) {
      members.value = more ? [...members.value, ...result.items] : result.items;
      memberMore.value = result.has_more === true;
    }
  } catch (cause) {
    if (!controller.signal.aborted && mine === rosterRevision)
      chat.error(cause);
  }
}
async function locate(message: Message) {
  try {
    await chat.locate(message);
    emit("close");
  } catch (cause) {
    chat.error(cause);
  }
}
async function oldest() {
  if (!chat.active.value) return;
  try {
    const page = await chat.api<History>(
      "/messages/locate?conversation_id=" + chat.active.value.id + "&first=1",
    );
    chat.mergeMessages(page.items, true);
    chat.located.value = page.items[0]?.id || null;
    emit("close");
  } catch (cause) {
    chat.error(cause);
  }
}
void loadMembers();
void calendar();
onScopeDispose(() => {
  revision++;
  rosterRevision++;
  controller.abort();
});
</script>
<template>
  <BaseDialog title="搜索聊天记录" @close="emit('close')"
    ><form class="vue-fields" @submit.prevent="search()">
      <input
        v-model="keyword"
        aria-label="搜索消息"
        placeholder="搜索消息"
      /><label><input v-model="scope" type="checkbox" />仅当前会话</label
      ><label
        >日期<input
          v-model="date"
          aria-label="筛选日期"
          type="date"
          :min="firstDate || undefined"
          :max="today" /></label
      ><label v-if="chat.active.value?.type === 'group'"
        >搜索发送者<input v-model="memberQuery" @input="loadMembers()" /></label
      ><button
        v-if="memberMore"
        type="button"
        @click="
          memberPage++;
          loadMembers(true);
        "
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
      ><button class="primary" :disabled="busy">搜索</button
      ><button type="button" @click="oldest">定位最早消息</button>
    </form>
    <div class="vue-search-results">
      <button
        v-for="message in items"
        :key="message.conversation_id + ':' + message.id"
        @click="locate(message)"
      >
        <strong>{{ message.sender_name }}</strong><time>{{
          message.created_at
        }}</time>
        <p>{{ textOf(message) }}</p></button
      ><button
        v-if="hasMore"
        :disabled="busy"
        @click="
          page++;
          search(true);
        "
      >
        加载更多
      </button>
    </div></BaseDialog
  >
</template>
