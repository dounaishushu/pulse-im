<script setup lang="ts">
import { computed, inject, shallowRef } from "vue";
import { chatKey } from "../../composables/useChat";
import ForwardPicker from "./ForwardPicker.vue";
const chat = inject(chatKey)!;

const selected = computed(() =>
  chat.messages.value.filter((row) => chat.selection.value.includes(row.id)),
);
const forwarding = shallowRef(false),
  busy = shallowRef(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(
      selected.value
        .map((row) => row.body.text || "")
        .filter(Boolean)
        .join("\n"),
    );
  } catch (cause) {
    chat.error(cause);
  }
}
async function remove() {
  if (chat.me.value?.internal_staff !== true || !chat.active.value || !confirm("删除所选消息？仅对自己生效。")) return;
  const source = chat.active.value.id;
  const ids = [...chat.selection.value];
  busy.value = true;
  try {
    await chat.post("/messages/delete", {
      conversation_id: source,
      message_ids: ids,
    });
    if (chat.active.value?.id === source) chat.deleteLocally(ids);
  } catch (cause) {
    chat.error(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section v-if="chat.selection.value.length" class="vue-batch-toolbar">
    <strong>已选 {{ chat.selection.value.length }} 条</strong
    ><button :disabled="busy" @click="copy">复制所选内容</button
    ><button :disabled="busy" @click="forwarding = true">转发所选内容</button
    ><button v-if="chat.me.value?.internal_staff === true" :disabled="busy" @click="remove">删除所选内容</button
    ><button :disabled="busy" @click="chat.selection.value = []">
      取消选择
    </button>
  </section>
  <ForwardPicker
    v-if="forwarding"
    :messages="selected"
    @close="forwarding = false"
    @complete="
      forwarding = false;
      chat.selection.value = [];
    "
  />
</template>
