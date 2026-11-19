<script setup lang="ts">
import { computed, inject, shallowRef, watch } from "vue";
import ForwardPicker from "./ForwardPicker.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { chatKey } from "../../composables/useChat";
import type { Message, Conversation } from "../../api/types";
import { textOf } from "../../api/types";
const props = defineProps<{ message: Message }>();
const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const forwarding = shallowRef(false),
  receipts = shallowRef<{ user_id?: string; status?: string; name?: string }[]>(
    [],
  ),
  showingReceipts = shallowRef(false),
  busy = shallowRef(false);
const receiptSummary = shallowRef<{
  recipient_count: number;
  delivered_count: number;
  read_count: number;
} | null>(null);

const own = computed(() => props.message.sender_id === chat.me.value?.id);
const sourceConversation = props.message.conversation_id;
const canMutate = computed(
  () =>
    own.value &&
    chat.canSend.value &&
    !props.message.body.poll_id &&
    chat.me.value?.internal_staff === true &&
    props.message.status !== "recalled",
);
const canPin = computed(
  () =>
    chat.canSend.value &&
    (chat.active.value?.type !== "group" || chat.active.value.can_manage),
);
const pinned = computed(() =>
  chat.pins.value.some((row) => row.id === props.message.id),
);
watch(
  () => chat.active.value?.id,
  (id) => {
    if (id !== sourceConversation) emit("close");
  },
);
async function act(operation: string) {
  if (busy.value || chat.active.value?.id !== sourceConversation) return;
  busy.value = true;
  try {
    if (operation === "copy")
      await navigator.clipboard.writeText(props.message.body.text || "");
    if (operation === "reply") chat.reply.value = props.message;
    if (operation === "select") chat.selection.value = [props.message.id];
    if (operation === "edit") {
      const text = prompt("编辑消息", props.message.body.text);
      if (text === null) return;
      const result = await chat.post<Message>("/messages/edit", {
        conversation_id: sourceConversation,
        message_id: props.message.id,
        expected_version: props.message.body._go_version,
        text,
      });
      chat.mergeMessages([result]);
    }
    if (operation === "recall" && confirm("撤回这条消息？")) {
      await chat.post("/messages/recall", {
        conversation_id: sourceConversation,
        message_id: props.message.id,
      });
      await chat.sync();
    }
    if (operation === "delete" && chat.me.value?.internal_staff === true && confirm("仅对自己删除这条消息？")) {
      await chat.post("/messages/delete", {
        conversation_id: sourceConversation,
        message_ids: [props.message.id],
      });
      if (chat.active.value?.id === sourceConversation)
        chat.deleteLocally([props.message.id]);
    }
    if (operation === "pin") {
      await chat.post(pinned.value ? "/messages/unpin" : "/messages/pin", {
        conversation_id: sourceConversation,
        message_id: props.message.id,
      });
      await chat.loadPins();
    }
    if (operation === "receipt") {
      const result = await chat.api<{
        recipient_count: number;
        delivered_count: number;
        read_count: number;
        items?: typeof receipts.value;
        receipts?: typeof receipts.value;
      }>(
        "/messages/receipts?conversation_id=" +
          sourceConversation +
          "&message_id=" +
          props.message.id,
      );
      receipts.value = result.items || result.receipts || [];
      receiptSummary.value = result;
      showingReceipts.value = true;
      return;
    }
    if (operation === "save") {
      const favorite = await chat.post<Conversation>(
        "/conversations/favorites",
        {},
      );
      await chat.post("/messages", {
        conversation_id: favorite.id,
        type: props.message.type,
        body: { _source_wire_id: props.message.body._go_wire_id },
        request_id: "saved-" + crypto.randomUUID(),
      });
    }
    emit("close");
  } catch (cause) {
    chat.error(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <ForwardPicker
    v-if="forwarding"
    :messages="[message]"
    @close="forwarding = false"
    @complete="emit('close')"
  />
  <BaseDialog
    v-else
    :title="
      forwarding ? '转发消息' : showingReceipts ? '消息阅读回执' : '消息操作'
    "
    :busy="busy"
    size="compact"
    @close="emit('close')"
  >
    <p>{{ textOf(message) }}</p>
    <template v-if="showingReceipts"
      ><dl v-if="receiptSummary" class="vue-details">
        <dt>接收人数</dt>
        <dd>{{ receiptSummary.recipient_count }}</dd>
        <dt>已送达</dt>
        <dd>{{ receiptSummary.delivered_count }}</dd>
        <dt>已读</dt>
        <dd>{{ receiptSummary.read_count }}</dd>
      </dl>
      <p v-for="(receipt, index) in receipts" :key="index">
        {{ receipt.name || receipt.user_id }} · {{ receipt.status }}
      </p>
      <p v-if="!receipts.length && !receiptSummary">暂无阅读回执</p></template
    >
    <div v-else class="vue-action-list">
      <button v-if="message.body.text" @click="act('copy')">复制</button
      ><button :disabled="!chat.canSend.value" @click="act('reply')">
        回复</button
      ><button
        v-if="
          message.status !== 'recalled' &&
          [
            'text',
            'image',
            'video',
            'file',
            'voice',
            'audio',
            'contact_card',
          ].includes(message.type)
        "
        @click="forwarding = true"
      >
        转发</button
      ><button
        v-if="
          message.status !== 'recalled' &&
          [
            'text',
            'image',
            'video',
            'file',
            'voice',
            'audio',
            'contact_card',
          ].includes(message.type)
        "
        @click="act('save')"
      >
        收藏</button
      ><button @click="act('select')">选择此消息</button
      ><button v-if="chat.me.value?.internal_staff === true" class="vue-button-danger" @click="act('delete')">删除</button
      ><button v-if="canPin" @click="act('pin')">
        {{ pinned ? "取消置顶" : "置顶消息" }}</button
      ><button v-if="canMutate && message.type === 'text'" @click="act('edit')">
        编辑</button
      ><button v-if="canMutate" class="vue-button-danger" @click="act('recall')">撤回</button
      ><button v-if="own" @click="act('receipt')">阅读回执</button>
    </div>
  </BaseDialog>
</template>
