<script lang="ts">
const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
});
const calendar = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
});
</script>

<script setup lang="ts">
import { computed, inject, onScopeDispose, shallowRef } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { messageOf } from "../../api/client";
import UiIcon from "../../components/UiIcon.vue";
import { chatKey } from "../../composables/useChat";
import type { Notification, Page } from "../../api/types";
import NotificationRow from "./NotificationRow.vue";

const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const rows = shallowRef<Notification[]>([]);
const filterUnread = shallowRef(false);
const nextBefore = shallowRef("");
const loading = shallowRef(false);
const working = shallowRef(false);
const loadError = shallowRef("");
const lifetime = new AbortController();
onScopeDispose(() => lifetime.abort());

interface NotificationPage extends Page<Notification> {
  unread_count: number;
  next_before_id?: string;
}
const sections = computed(() => {
  const list = new Map<string, { row: Notification; time: string }[]>();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  for (const row of rows.value) {
    if (filterUnread.value && !row.unread) continue;
    const time = new Date(row.created_at ?? "");
    const valid = Number.isFinite(time.getTime());
    let category = "更早";
    if (valid) {
      const day = time.toDateString();
      if (day === today.toDateString()) category = "今天";
      else if (day === yesterday.toDateString()) category = "昨天";
      else category = calendar.format(time);
    }
    const item = { row, time: valid ? clock.format(time) : "" };
    const section = list.get(category);
    if (section) section.push(item);
    else list.set(category, [item]);
  }
  return list;
});

async function load(more = false) {
  if (loading.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    const params = new URLSearchParams({ limit: "30" });
    if (more && nextBefore.value) params.set("before_id", nextBefore.value);
    const data = await chat.api<NotificationPage>(`/notifications?${params}`, {
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]),
    });
    if (lifetime.signal.aborted) return;
    rows.value = more ? [...rows.value, ...data.items] : data.items;
    nextBefore.value = data.next_before_id || "";
    chat.notificationUnread.value = data.unread_count;
  } catch (cause) {
    if (lifetime.signal.aborted) return;
    loadError.value = messageOf(cause);
    const status = (cause as { status?: number } | null)?.status;
    if (status === 401 || status === 426) chat.error(cause);
  } finally {
    loading.value = false;
  }
}
async function perform(task: () => Promise<void>) {
  if (working.value) return;
  working.value = true;
  try {
    await task();
  } catch (cause) {
    if (!lifetime.signal.aborted) chat.error(cause);
  } finally {
    working.value = false;
  }
}
async function readOne(id: number) {
  const data = await chat.post<{ unread_count: number }>(
    "/notifications/read",
    { ids: [id] },
  );
  chat.notificationUnread.value = data.unread_count;
  rows.value = rows.value.map((row) =>
    row.id === id ? { ...row, unread: false } : row,
  );
}
function readAll() {
  const newest = rows.value[0]?.id;
  if (!newest) return;
  void perform(async () => {
    await chat.client.raw("/notifications/read", {
      method: "PUT",
      body: { through_id: String(newest) },
    });
    rows.value = rows.value.map((row) =>
      row.id <= newest ? { ...row, unread: false } : row,
    );
    await chat.refreshNotificationCount();
  });
}
function decide(row: Notification, action: "accept" | "reject") {
  void perform(async () => {
    await chat.post("/contact-requests/handle", {
      request_id: row.request_id,
      action,
    });
    const requestStatus = action === "accept" ? "accepted" : "rejected";
    rows.value = rows.value.map((item) =>
      item.id === row.id ? { ...item, request_status: requestStatus } : item,
    );
    if (row.unread) await readOne(row.id);
    void chat.loadDirectory();
    void chat.refreshNames();
  });
}
function open(id: number) {
  void chat.choose(id).catch(chat.error);
  emit("close");
}
void load();
</script>

<template>
  <BaseDialog title="消息中心" layout="notifications" @close="emit('close')">
    <div class="notification-center">
      <div class="notifications-toolbar">
        <div class="notifications-filter" role="group" aria-label="筛选通知">
          <button
            type="button"
            :aria-pressed="!filterUnread"
            @click="filterUnread = false"
          >
            全部
          </button>
          <button
            type="button"
            :aria-pressed="filterUnread"
            @click="filterUnread = true"
          >
            未读<span
              v-if="chat.notificationUnread.value"
              class="notifications-count"
              >{{ chat.notificationUnread.value }}</span
            >
          </button>
        </div>
        <button
          type="button"
          class="ui-text-button notifications-read-all"
          :disabled="
            working || loading || !rows.length || !chat.notificationUnread.value
          "
          @click="readAll"
        >
          <UiIcon name="check" /> 全部标为已读
        </button>
      </div>
      <div class="notifications-scroll" :aria-busy="loading">
        <section
          v-for="[day, items] in sections"
          :key="day"
          class="notifications-day"
        >
          <h3>{{ day }}</h3>
          <NotificationRow
            v-for="item in items"
            :key="item.row.id"
            :row="item.row"
            :working="working || loading"
            @read="perform(() => readOne(item.row.id))"
            @decide="decide(item.row, $event)"
            @open="open"
          >
            <template #time>
              <time v-if="item.time" :datetime="item.row.created_at">{{
                item.time
              }}</time>
            </template>
          </NotificationRow>
        </section>
        <div v-if="loadError" role="status" class="notifications-state">
          <span>通知加载失败</span>
          <span>{{ loadError }}</span>
          <button
            type="button"
            class="ui-text-button"
            @click="load(!!nextBefore)"
          >
            重试
          </button>
        </div>
        <div
          v-else-if="!sections.size"
          role="status"
          class="notifications-state"
        >
          <UiIcon v-if="!loading" name="bell" />
          <span>{{
            loading
              ? "正在加载通知…"
              : filterUnread
                ? "当前列表暂无未读通知"
                : "暂无通知"
          }}</span>
        </div>
        <button
          v-if="nextBefore && !loadError"
          type="button"
          class="ui-text-button notifications-more"
          :disabled="working || loading"
          @click="load(true)"
        >
          {{ loading ? "加载中…" : "加载更多" }}
        </button>
      </div>
    </div>
  </BaseDialog>
</template>

<style scoped>
.notification-center {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.notifications-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--ui-line);
  background: var(--ui-surface-soft);
}
.notifications-filter {
  display: flex;
  gap: 3px;
}
.notifications-filter button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: transparent;
  color: var(--ui-muted);
  font-size: 13px;
  white-space: nowrap;
}
.notifications-filter button[aria-pressed="true"] {
  background: var(--art-active-color);
  color: var(--ui-primary);
  font-weight: 600;
}
.notifications-count {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.notifications-read-all {
  padding-inline: 7px;
  font-size: 12px;
  white-space: nowrap;
}
.notifications-scroll {
  flex: 1;
  min-height: 0;
  padding: 0 10px max(10px, env(safe-area-inset-bottom));
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.notifications-scroll .notifications-day > h3 {
  padding: 5px 10px;
  margin: 8px 0 1px;
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: 550;
}
.notifications-day time {
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 1.65;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.notifications-state {
  display: grid;
  justify-items: center;
  align-content: center;
  min-height: 160px;
  gap: 8px;
  padding: 14px;
  color: var(--ui-muted);
  font-size: 13px;
}
.notifications-state > .ui-icon {
  font-size: 27px;
}
.notifications-more {
  display: flex;
  margin: 8px auto;
  font-size: 13px;
}
</style>
