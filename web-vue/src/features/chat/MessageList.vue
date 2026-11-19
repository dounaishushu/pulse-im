<script lang="ts">
const messageTime = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Shanghai",
});
const messageDay = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  timeZone: "Asia/Shanghai",
});
const dayInShanghai = (time: number) =>
  Math.floor((time + 8 * 3600000) / 86400000);
</script>
<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onMounted,
  onScopeDispose,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import { chatKey } from "../../composables/useChat";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import MediaContent from "./MediaContent.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { copyMessageSelection } from "./messageSelection";
import type { Message } from "../../api/types";
import { usePreferences } from "../../composables/usePreferences";
const props = defineProps<{ desktopGroup?: boolean }>();
const chat = inject(chatKey)!;
const preferences = usePreferences();
const { messages, me, loading, hasMore, olderLoading } = chat;
const timeBreaks = computed(() => {
  const labels = new Map<number, string>();
  if (!props.desktopGroup) return labels;
  const today = dayInShanghai(Date.now());
  let previous = NaN;
  for (const message of messages.value) {
    const time = Date.parse(message.created_at);
    if (!Number.isFinite(time)) continue;
    const day = dayInShanghai(time);
    if (day !== dayInShanghai(previous) || time - previous >= 5 * 60000) {
      const date =
        day === today
          ? ""
          : day === today - 1
            ? "昨天"
            : messageDay.format(time);
      labels.set(
        message.id,
        [date, messageTime.format(time)].filter(Boolean).join(" "),
      );
    }
    previous = time;
  }
  return labels;
});
const emit = defineEmits<{
  action: [message: Message];
  member: [message: Message];
}>();
const area = useTemplateRef<HTMLElement>("area"),
  lightbox = shallowRef(""),
  follow = shallowRef(true),
  newCount = shallowRef(0);
let beforeHeight = 0,
  lastRead = 0,
  lastId = 0,
  scrollFrame = 0,
  programmatic = false;
let readerGesture = false;
const lifetime = new AbortController();
let resize: ResizeObserver | undefined,
  mutations: MutationObserver | undefined,
  readTimer: ReturnType<typeof setTimeout> | undefined;
const observed = new Set<Element>();
function formatTime(date: string) {
  const time = Date.parse(date);
  return Number.isFinite(time) ? messageTime.format(time) : "";
}
async function older() {
  if (!area.value) return;
  const height = area.value.scrollHeight,
    offset = area.value.scrollTop,
    navigation = chat.openRevision.value;
  follow.value = false;
  await chat.older();
  await nextTick();
  if (area.value && chat.openRevision.value === navigation)
    area.value.scrollTop = area.value.scrollHeight - height + offset;
}
function bottom() {
  if (area.value) {
    programmatic = true;
    area.value.scrollTop = area.value.scrollHeight;
    requestAnimationFrame(() => {
      programmatic = false;
    });
  }
  readerGesture = false;
  follow.value = true;
  newCount.value = 0;
}
let reading = false;
function lastVisibleMessage(container: HTMLElement) {
  // The direct message rows follow ascending IDs and normal vertical flow.
  const rows = container.children;
  let first = 0,
    last = rows.length - 1;
  while (first <= last && !rows[first]?.hasAttribute("data-message-id"))
    first++;
  while (last >= first && !rows[last]?.hasAttribute("data-message-id")) last--;
  if (first > last || !container.clientHeight) return 0;
  const bounds = container.getBoundingClientRect();
  let candidate: Element | undefined;
  while (first <= last) {
    const middle = (first + last) >>> 1;
    const row = rows[middle]!;
    const messageBody = row.classList.contains("has-time-break")
      ? (row.querySelector(".vue-message-stack") ?? row)
      : row;
    if (messageBody.getBoundingClientRect().top < bounds.bottom) {
      candidate = row;
      first = middle + 1;
    } else last = middle - 1;
  }
  return candidate && candidate.getBoundingClientRect().bottom > bounds.top
    ? Number(candidate.getAttribute("data-message-id"))
    : 0;
}
async function readVisible() {
  if (!area.value || reading) return;
  const seq = lastVisibleMessage(area.value);
  if (seq > lastRead) {
    const cid = chat.active.value?.id;
    reading = true;
    try {
      if (await chat.read(seq))
        if (chat.active.value?.id === cid) lastRead = seq;
    } finally {
      reading = false;
    }
  }
}
function scroll() {
  if (!area.value) return;
  const atBottom =
    area.value.scrollHeight - area.value.scrollTop - area.value.clientHeight <
    80;
  if (atBottom) {
    follow.value = true;
    readerGesture = false;
    newCount.value = 0;
  } else if (readerGesture && !programmatic) follow.value = false;
  clearTimeout(readTimer);
  readTimer = setTimeout(readVisible, 200);
}
function scheduleLayout() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (follow.value && !chat.located.value) bottom();
    readVisible();
  });
}
function pauseFollow() {
  readerGesture = true;
  follow.value = false;
}
watch(
  () => chat.active.value?.id,
  async () => {
    follow.value = true;
    newCount.value = 0;
    lastRead = 0;
    lastId = 0;
    readerGesture = false;
    await nextTick();
    bottom();
  },
);
watch(messages, async (items, previous) => {
  if (chat.located.value) follow.value = false;
  let newStart = items.length;
  while (newStart > 0 && items[newStart - 1]!.id > lastId) newStart--;
  const fresh = items.length - newStart;
  lastId = Math.max(lastId, items.at(-1)?.id || 0);
  const first = previous?.[0]?.id;
  beforeHeight = area.value?.scrollHeight || 0;
  await nextTick();
  if (follow.value) bottom();
  else if (first && items[0]?.id === first) newCount.value += fresh;
  scheduleLayout();
});
watch(chat.sendRevision, async () => {
  if (chat.located.value && chat.active.value)
    await chat.choose(chat.active.value.id);
  await nextTick();
  bottom();
});
watch(chat.located, async (id) => {
  if (id == null) return;
  follow.value = false;
  await nextTick();
  area.value
    ?.querySelector('[data-message-id="' + id + '"]')
    ?.scrollIntoView({ block: "center" });
});
onMounted(() => {
  const container = area.value;
  if (!container) return;
  resize = new ResizeObserver(scheduleLayout);
  resize.observe(container);
  const observe = (node: Node) => {
    if (
      node instanceof Element &&
      node.parentElement === container &&
      !observed.has(node)
    ) {
      observed.add(node);
      resize?.observe(node);
    }
  };
  mutations = new MutationObserver((changes) => {
    for (const change of changes) {
      for (const node of change.removedNodes)
        if (
          node instanceof Element &&
          node.parentElement !== container &&
          observed.delete(node)
        )
          resize?.unobserve(node);
      for (const node of change.addedNodes) observe(node);
    }
    scheduleLayout();
  });
  mutations.observe(container, { childList: true });
  for (const node of container.children) observe(node);
  scheduleLayout();
  container.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaY < 0) pauseFollow();
    },
    { passive: true, signal: lifetime.signal },
  );
  container.addEventListener("touchmove", pauseFollow, {
    passive: true,
    signal: lifetime.signal,
  });
  container.addEventListener(
    "pointerdown",
    (event) => {
      if (
        event.clientX >=
        container.getBoundingClientRect().right -
          (container.offsetWidth - container.clientWidth || 14)
      )
        pauseFollow();
    },
    { passive: true, signal: lifetime.signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) &&
        !(event.target as HTMLElement)?.closest(
          "input,textarea,[contenteditable=true]",
        )
      )
        pauseFollow();
    },
    { signal: lifetime.signal },
  );
  window.visualViewport?.addEventListener("resize", scheduleLayout, {
    signal: lifetime.signal,
  });
  window.addEventListener("resize", scheduleLayout, {
    signal: lifetime.signal,
  });
});
onScopeDispose(() => {
  lifetime.abort();
  resize?.disconnect();
  mutations?.disconnect();
  cancelAnimationFrame(scrollFrame);
  clearTimeout(readTimer);
});
function copy(event: ClipboardEvent) {
  if (area.value) copyMessageSelection(event, area.value);
}
function mediaLoaded() {
  if (follow.value && area.value && area.value.scrollHeight >= beforeHeight)
    scheduleLayout();
}
</script>
<template>
  <div
    ref="area"
    id="messages"
    class="messages vue-messages"
    role="log"
    aria-label="聊天消息"
    :style="preferences.background.value"
    @copy="copy"
    @scroll.passive="scroll"
    @load.capture="mediaLoaded"
  >
    <button
      v-if="chat.located.value"
      class="vue-history-more"
      @click="chat.active.value && chat.choose(chat.active.value.id)"
    >
      返回最新消息
    </button>
    <button
      v-if="hasMore"
      class="vue-history-more"
      :disabled="olderLoading"
      @click="older"
    >
      {{ olderLoading ? "加载中…" : "加载更早消息" }}
    </button>
    <p v-if="loading" role="status" class="empty">正在加载消息…</p>
    <p v-else-if="!messages.length" class="empty">暂无消息</p>
    <article
      v-for="message in messages"
      :key="message.conversation_id + ':' + message.id"
      class="vue-message-row"
      :class="{
        mine: message.sender_id === me?.id,
        'has-time-break': timeBreaks.has(message.id),
      }"
      :data-message-id="message.id"
      @contextmenu.prevent="emit('action', message)"
    >
      <time
        v-if="timeBreaks.has(message.id)"
        class="vue-message-break"
        :datetime="message.created_at"
      >
        {{ timeBreaks.get(message.id) }}
      </time>
      <input
        v-if="chat.selection.value.length"
        v-model="chat.selection.value"
        type="checkbox"
        :value="message.id"
        :disabled="
          !chat.selection.value.includes(message.id) &&
          chat.selection.value.length >= 100
        "
        :aria-label="'选择消息 ' + message.id"
        style="width: auto"
      />
      <AvatarImage
        :name="message.sender_id === me?.id ? me.nickname : message.sender_name"
        :src="
          message.sender_id === me?.id
            ? me.avatar_url
            : message.sender_avatar_url
        "
        @click="
          chat.active.value?.type === 'group' &&
          message.sender_id !== me?.id &&
          emit('member', message)
        "
        @contextmenu.stop.prevent="
          chat.active.value?.type === 'group' &&
          message.sender_id !== me?.id &&
          emit('member', message)
        "
      />
      <div class="vue-message-stack">
        <button
          v-if="message.sender_id !== me?.id"
          type="button"
          @click="
            chat.contactId.value = message.sender_id;
            chat.contactCard.value = null;
            chat.contactContext.value =
              chat.active.value?.type === 'group'
                ? chat.active.value.id
                : undefined;
            chat.panel.value = 'contacts';
          "
          class="vue-message-sender"
        >
          {{ chat.contactName(message.sender_id, message.sender_name) }}
        </button>
        <div class="bubble" :class="{ mine: message.sender_id === me?.id }">
          <blockquote v-if="message.body.reply_to">
            {{
              message.body.reply_to.unavailable
                ? "引用内容已不可用"
                : `${message.body.reply_to.sender_name || ""}：${message.body.reply_to.text || ""}`
            }}
          </blockquote>
          <span v-if="message.status === 'recalled'" class="muted"
            >消息已撤回</span
          >
          <MediaContent
            v-else-if="
              ['image', 'video', 'voice', 'audio', 'file'].includes(
                message.type,
              )
            "
            :message="message"
            @open="lightbox = $event"
          />
          <button
            v-else-if="message.type === 'contact_card'"
            @click="
              chat.contactId.value = message.body.user_id;
              chat.contactCard.value = {
                conversation: message.conversation_id,
                message: message.id,
              };
              chat.panel.value = 'contacts';
            "
          >
            个人名片：{{ message.body.nickname }}
          </button>
          <p v-else class="vue-message-text">
            {{
              message.body.poll_id
                ? "历史投票记录（只读）"
                : message.type === "red_packet"
                  ? "历史红包（功能已停用）"
                  : message.type === "shake"
                    ? "窗口抖动"
                    : message.body.text || "[消息]"
            }}
          </p>
          <p
            v-if="message.type !== 'text' && message.body.text"
            class="vue-message-text"
          >
            {{ message.body.text }}
          </p>
        </div>
        <small class="vue-message-meta"
          ><time :datetime="message.created_at">{{
            formatTime(message.created_at)
          }}</time
          ><span v-if="message.edited_at"> · 已编辑</span
          ><button
            class="vue-message-more"
            aria-label="消息操作"
            @click="emit('action', message)"
          >
            <UiIcon name="more" /></button
        ></small>
      </div>
    </article>
    <button v-if="newCount" class="vue-new-messages" @click="bottom">
      {{ newCount }} 条新消息 ↓
    </button>
  </div>
  <BaseDialog v-if="lightbox" title="查看图片" @close="lightbox = ''"
    ><img :src="lightbox" class="vue-full-image" alt="完整图片" /><a
      :href="lightbox"
      target="_blank"
      rel="noreferrer"
      download
      >下载图片</a
    ></BaseDialog
  >
</template>

<style scoped>
.vue-messages {
  display: block;
  position: relative;
  min-height: 0;
  flex: 1;
  padding: 19px clamp(14px, 2vw, 32px) 12px;
  overflow: auto;
  overflow-anchor: none;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  background-color: var(--ui-canvas);
  background-position: center;
}
.vue-messages > .empty {
  padding: 12px 0;
  text-align: center;
  font-size: 12px;
}
.vue-message-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding-block: 0 13px;
  min-width: 0;
}
.vue-message-row.has-time-break {
  flex-wrap: wrap;
}
.vue-message-break {
  flex: 0 0 100%;
  margin: 2px 0 5px;
  color: var(--ui-muted);
  font-size: var(--ui-font-caption);
  line-height: var(--ui-line-heading);
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.vue-message-row.mine {
  flex-direction: row-reverse;
}
.vue-message-row > .avatar {
  --avatar-size: 34px;
}
.vue-message-row > input[type="checkbox"] {
  align-self: center;
  accent-color: var(--ui-primary);
}
.vue-message-stack {
  min-width: 0;
  max-width: min(72%, 620px);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}
.vue-message-row.mine .vue-message-stack {
  align-items: flex-end;
}
.vue-message-row .bubble {
  position: relative;
  min-width: 0;
  max-width: 100%;
  border: 0;
  border-radius: 3px 9px 9px 9px;
  padding: 7px 11px;
  font-size: var(--ui-font-content);
  line-height: var(--ui-line-content);
  background: var(--ui-bubble);
  color: var(--ui-text);
}
.vue-message-row .bubble.mine {
  background: var(--ui-outgoing);
  color: var(--ui-outgoing-text);
  border-radius: 9px 3px 9px 9px;
}
.vue-message-row .bubble :is(button:not(.vue-image-button), a) {
  color: inherit;
}
.vue-message-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.vue-message-text + .vue-message-text {
  margin-top: 5px;
}
.vue-message-row .vue-message-sender {
  max-width: 100%;
  padding: 0;
  margin: 0 1px;
  border: 0;
  color: var(--ui-muted);
  background: transparent;
  border-radius: 2px;
  font-size: var(--ui-font-secondary);
  line-height: var(--ui-line-heading);
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  text-align: start;
  font-weight: 500;
}
.vue-message-row .vue-message-sender:hover {
  color: var(--ui-primary);
  background: transparent;
}
.vue-message-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 18px;
  color: var(--ui-muted);
  font-size: var(--ui-font-caption);
  font-variant-numeric: tabular-nums;
}
.vue-message-meta .vue-message-more {
  width: 24px;
  height: 20px;
  padding: 0;
  font-size: 13px;
  display: inline-grid;
  place-items: center;
  color: var(--ui-muted);
  background: transparent;
}
.vue-message-meta .vue-message-more:hover {
  background: var(--ui-fill);
  color: var(--ui-primary);
}
.bubble blockquote {
  border-inline-start: 2px solid currentColor;
  background: rgb(0 0 0 / 8%);
  border-radius: 3px;
  margin-bottom: 5px;
  padding: 4px 7px;
  font-size: var(--ui-font-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bubble.mine .muted {
  color: inherit;
}
.vue-message-row :deep(.vue-image-button) {
  display: block;
  padding: 0;
  max-width: 100%;
  background: transparent;
}
.vue-message-row .bubble :deep(:is(img, video)) {
  max-width: min(335px, 100%);
  max-height: 350px;
  object-fit: contain;
  border-radius: 5px;
}
.vue-message-row :deep(audio) {
  max-width: 100%;
}
.vue-full-image {
  margin-inline: auto;
  max-height: 66dvh;
  border-radius: 5px;
  object-fit: contain;
}
.vue-media-error :is(button, a) {
  margin-inline-start: 7px;
}
.vue-messages .vue-history-more {
  display: block;
  margin: 0 auto 16px;
  background: var(--ui-surface-soft);
  border: 1px solid var(--ui-line);
  font-size: 12px;
}
.vue-messages .vue-new-messages {
  position: sticky;
  bottom: 0;
  display: block;
  margin-inline-start: auto;
  background: var(--ui-surface);
  color: var(--ui-primary);
  box-shadow: var(--ui-popover-shadow);
  font-size: 12px;
}
@media (max-width: 760px) {
  .vue-message-stack {
    max-width: min(81%, 580px);
  }
}
</style>
