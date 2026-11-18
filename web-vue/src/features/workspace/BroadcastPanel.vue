<script setup lang="ts">
import { computed, inject, shallowRef } from "vue";
import { chatKey } from "../../composables/useChat";

import BaseDialog from "../../components/BaseDialog.vue";
const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const client = chat.client;
const body = shallowRef(""),
  selected = shallowRef<number[]>([]),
  busy = shallowRef(false),
  status = shallowRef(""),
  batch = shallowRef(
    localStorage.getItem("pulse_vue_broadcast:" + chat.me.value?.id) || "",
  );
const targets = computed(() =>
  chat.conversations.value.filter(
    (row) => row.type !== "favorites" && row.can_send !== false,
  ),
);
async function check() {
  if (!batch.value) return;
  try {
    const result = await client.raw<{
      items: { batch_status: string; status: string }[];
    }>("/send-batches/" + encodeURIComponent(batch.value) + "?page=1&size=100");
    status.value =
      (result.items[0]?.batch_status || "未知") +
      " · " +
      result.items.filter((row) => row.status === "sent").length +
      "/" +
      result.items.length;
  } catch (cause) {
    chat.error(cause);
  }
}
async function send() {
  if (
    !chat.me.value?.internal_staff ||
    busy.value ||
    !selected.value.length ||
    !body.value.trim()
  )
    return;
  busy.value = true;
  try {
    const result = await client.raw<{ id: string }>("/broadcasts", {
      method: "POST",
      body: {
        request_id: "web-broadcast-" + crypto.randomUUID(),
        conversation_ids: selected.value.map((id) =>
          client.wire("conversation", id),
        ),
        body: body.value,
        attachments: [],
      },
    });
    batch.value = result.id;
    localStorage.setItem("pulse_vue_broadcast:" + chat.me.value.id, result.id);
    await check();
  } catch (cause) {
    chat.error(cause);
  } finally {
    busy.value = false;
  }
}
async function control(operation: string) {
  if (!batch.value) return;
  busy.value = true;
  try {
    await client.raw(
      "/send-batches/" + batch.value + (operation === "retry" ? "/retry" : ""),
      {
        method: operation === "retry" ? "POST" : "DELETE",
        body: operation === "retry" ? {} : undefined,
      },
    );
    await check();
  } catch (cause) {
    chat.error(cause);
  } finally {
    busy.value = false;
  }
}
if (batch.value) void check();
</script>
<template>
  <BaseDialog title="群发任务" @close="emit('close')"
    ><p>已创建的任务由服务器执行，关闭窗口后继续发送。</p>
    <form class="vue-fields" @submit.prevent="send">
      <label
        >消息<textarea
          v-model="body"
          required
          maxlength="20000"
        ></textarea></label
      ><label v-for="row in targets" :key="row.id"
        ><input v-model="selected" type="checkbox" :value="row.id" />{{
          row.name
        }}</label
      ><button class="primary" :disabled="busy || !selected.length">
        创建任务
      </button>
    </form>
    <section v-if="batch">
      <p role="status">{{ status }}</p>
      <button :disabled="busy" @click="check">刷新进度</button
      ><button :disabled="busy" @click="control('retry')">重试未完成目标</button
      ><button :disabled="busy" @click="control('cancel')">取消剩余任务</button>
    </section></BaseDialog
  >
</template>
