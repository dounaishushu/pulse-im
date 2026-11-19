<script setup lang="ts">
import { inject, onMounted, shallowRef } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { chatKey } from "../../composables/useChat";
import type { Notification, Page } from "../../api/types";
import "../../../../web/vendor/qrcode.js";
declare global {
  interface Window {
    PulseQrCode: {
      toDataURL(
        value: string,
        options: { width: number; margin: number },
      ): Promise<string>;
    };
  }
}
const props = defineProps<{ mode: "notifications" | "qr" | "calls" }>();
const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const rows = shallowRef<Notification[]>([]),
  qr = shallowRef(""),
  hasMore = shallowRef(false),
  busy = shallowRef(false);
async function load(more = false) {
  if (props.mode !== "notifications") return;
  busy.value = true;
  try {
    const last = rows.value.at(-1)?.id;
    const result = await chat.api<Page<Notification>>(
      "/notifications?limit=30" + (more && last ? "&before_id=" + last : ""),
    );
    rows.value = more ? [...rows.value, ...result.items] : result.items;
    hasMore.value = result.items.length === 30;
  } catch (cause) {
    chat.error(cause);
  } finally {
    busy.value = false;
  }
}
async function read(ids: number[]) {
  try {
    const value = await chat.post<{ unread_count: number }>(
      "/notifications/read",
      { ids },
    );
    chat.notificationUnread.value = value.unread_count;
    rows.value = rows.value.map((row) =>
      ids.includes(row.id) ? { ...row, unread: false } : row,
    );
  } catch (cause) {
    chat.error(cause);
  }
}
async function decision(row: Notification, action: string) {
  try {
    await chat.post("/contact-requests/handle", {
      request_id: row.request_id,
      action,
    });
    await read([row.id]);
    await load();
    void chat.loadDirectory();
  } catch (cause) {
    chat.error(cause);
  }
}
onMounted(() => {
  if (props.mode === "notifications") void load();
  if (props.mode === "qr")
    void window.PulseQrCode.toDataURL(
      "pulse://add-friend?public_id=" +
        encodeURIComponent(chat.me.value?.public_id || ""),
      { width: 280, margin: 2 },
    )
      .then((result) => {
        qr.value = result;
      })
      .catch(chat.error);
});
</script>
<template>
  <BaseDialog
    :title="
      mode === 'qr' ? '我的二维码' : mode === 'calls' ? '通话记录' : '消息中心'
    "
    :size="mode === 'notifications' ? undefined : 'compact'"
    @close="emit('close')"
    ><div v-if="mode === 'qr'" class="vue-qr-panel"
      ><img v-if="qr" :src="qr" alt="我的账号二维码" />
      <p>ID：{{ chat.me.value?.public_id }}</p></div
    ><template v-else-if="mode === 'calls'"
      ><p>暂无通话记录。当前 Go 服务没有提供通话接口。</p>
      <button @click="chat.panel.value = 'settings'">
        通话设备设置
      </button></template
    ><template v-else
      ><button
        :disabled="busy || !rows.some((row) => row.unread)"
        @click="read(rows.filter((row) => row.unread).map((row) => row.id))"
      >
        全部标为已读
      </button>
      <article v-for="row in rows" :key="row.id" class="vue-notification">
        <strong>{{ row.title || row.actor_name || "通知" }}</strong>
        <p>{{ row.body || row.kind || row.type }}</p>
        <small>{{ row.created_at }}</small>
        <div
          v-if="row.unread || (row.request_id && row.request_status === 'pending') || row.conversation_id"
          class="vue-notification-actions"
        >
          <button v-if="row.unread" @click="read([row.id])">标为已读</button>
          <template v-if="row.request_id && row.request_status === 'pending'">
            <button @click="decision(row, 'accept')">同意</button>
            <button @click="decision(row, 'reject')">拒绝</button>
          </template>
          <button
            v-if="row.conversation_id"
            @click="
              chat.choose(row.conversation_id);
              emit('close');
            "
          >
            查看会话
          </button>
        </div>
      </article>
      <button v-if="hasMore" :disabled="busy" @click="load(true)">
        加载更多
      </button>
      <p v-if="!rows.length">暂无通知</p></template
    ></BaseDialog
  >
</template>

<style scoped>
.vue-qr-panel { display: grid; justify-items: center; text-align: center; }
.vue-qr-panel img { width: min(220px, 100%); height: auto; padding: 8px; background: #fff; border-radius: 8px; }
.vue-notification { padding: 12px 0; border-bottom: 1px solid var(--panel-line); }
.vue-notification p { margin: 4px 0; }
.vue-notification small { color: var(--panel-muted); }
.vue-notification-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
</style>
