<script setup lang="ts">
import { computed, inject, onScopeDispose, shallowRef, watch } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import AvatarImage from "../../components/AvatarImage.vue";
import { chatKey } from "../../composables/useChat";

import type { Conversation, Message } from "../../api/types";
const props = defineProps<{ messages: Message[] }>(),
  emit = defineEmits<{ close: []; complete: [] }>(),
  chat = inject(chatKey)!;
const client = chat.client;
const query = shallowRef(""),
  selected = shallowRef<number[]>([]),
  multi = shallowRef(false),
  busy = shallowRef(false),
  feedback = shallowRef("");
const rows = [...props.messages].sort((a, b) => a.id - b.id),
  source = chat.active.value?.id,
  token = client.token;
const controller = new AbortController(),
  ids = new Map<string, string>(),
  done = new Set<string>();
let queue: number[] | undefined, favorite: Conversation | undefined;
const targets = computed(() =>
  [
    {
      id: 0,
      type: "favorites",
      name: "收藏夹",
      message_seq: 0,
    } as Conversation,
    ...chat.conversations.value.filter(
      (row) =>
        row.type !== "favorites" &&
        !row.is_hidden &&
        row.can_send !== false &&
        row.can_publish !== false &&
        (row.type !== "channel" ||
          ["owner", "admin"].includes(row.my_role || "")),
    ),
  ].filter((row) =>
    [row.name, row.remark].some((value) =>
      value?.toLowerCase().includes(query.value.toLowerCase()),
    ),
  ),
);
const current = () =>
  !controller.signal.aborted &&
  client.token === token &&
  chat.active.value?.id === source;
watch(
  () => chat.active.value?.id,
  (id) => {
    if (id !== source) {
      controller.abort();
      emit("close");
    }
  },
);
function toggle(id: number) {
  if (queue) return;
  if (selected.value.includes(id))
    selected.value = selected.value.filter((item) => item !== id);
  else if (selected.value.length < 100)
    selected.value = [...selected.value, id];
  else feedback.value = "一次最多选择 100 个接收者";
}
function pick(id: number) {
  if (multi.value) toggle(id);
  else {
    selected.value = [id];
    void send();
  }
}
async function send() {
  if (
    busy.value ||
    !current() ||
    !selected.value.length ||
    !rows.length ||
    rows.length > 100
  )
    return;
  if (
    rows.some(
      (row) =>
        row.status === "recalled" ||
        row.recalled_at ||
        ![
          "text",
          "image",
          "video",
          "file",
          "voice",
          "audio",
          "contact_card",
        ].includes(row.type),
    )
  ) {
    feedback.value = "所选消息已变化，请重新选择";
    return;
  }
  busy.value = true;
  queue ||= [...selected.value];
  try {
    for (const target of queue) {
      if (!current()) return;
      if (target === 0 && !favorite)
        favorite = await chat.post<Conversation>(
          "/conversations/favorites",
          {},
        );
      for (const row of rows) {
        if (!current()) return;
        const key = target + ":" + row.conversation_id + ":" + row.id;
        if (done.has(key)) continue;
        if (!ids.has(key)) ids.set(key, "forward-" + crypto.randomUUID());
        feedback.value = `已发送 ${done.size} / ${queue.length * rows.length}`;
        await chat.api("/messages", {
          method: "POST",
          body: {
            conversation_id: target === 0 ? favorite!.id : target,
            type: row.type,
            body: { _source_wire_id: row.body._go_wire_id },
            request_id: ids.get(key),
          },
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20000),
          ]),
        });
        if (!current()) return;
        done.add(key);
      }
    }
    void chat.loadDirectory();
    emit("complete");
  } catch (cause) {
    if (current())
      feedback.value =
        (cause instanceof Error ? cause.message : "发送失败") +
        "，可继续发送未完成的部分";
  } finally {
    busy.value = false;
  }
}
onScopeDispose(() => controller.abort());
</script>
<template>
  <BaseDialog title="转发消息" :busy="busy" @close="emit('close')">
    <input
      v-model="query"
      :disabled="!!queue"
      aria-label="搜索接收者"
      placeholder="搜索接收者"
    />
    <button :disabled="!!queue" :aria-pressed="multi" @click="multi = !multi">
      {{ multi ? "取消多选" : "多选" }}
    </button>
    <p>
      转发 {{ messages.length }} 条消息 · 已选 {{ selected.length }} 位接收者
    </p>
    <div class="vue-forward-targets">
      <button
        v-for="target in targets"
        :key="target.id"
        :disabled="busy || !!queue"
        :aria-pressed="selected.includes(target.id)"
        @click="pick(target.id)"
        @contextmenu.prevent="
          multi = true;
          toggle(target.id);
        "
      >
        <AvatarImage :name="target.name" :src="target.avatar_url" />{{
          selected.includes(target.id) ? "✓ " : ""
        }}{{ target.name }}
      </button>
    </div>
    <p role="status">{{ feedback }}</p>
    <button
      v-if="multi || queue"
      class="primary"
      :disabled="busy || !selected.length"
      @click="send"
    >
      {{ busy ? "发送中…" : queue ? "继续发送" : "发送" }}
    </button>
  </BaseDialog>
</template>
