<script setup lang="ts">
import platform from "virtual:pulse-platform";
import { computed, inject, onScopeDispose, shallowRef, watch } from "vue";
import ForwardPicker from "./ForwardPicker.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import ContextMenu from "../../components/ContextMenu.vue";
import UiIcon from "../../components/UiIcon.vue";
import { chatKey } from "../../composables/useChat";
import type { Message, Conversation } from "../../api/types";

const props = defineProps<{ message: Message; point?: { x: number; y: number } }>();
const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const forwarding = shallowRef(false);
const showingReceipts = shallowRef(false);
const busy = shallowRef(false);
const copyingImage = shallowRef(false);
const editor = shallowRef(false);
const draft = shallowRef(props.message.body.text || "");
const confirmation = shallowRef<"delete" | null>(null);
const failure = shallowRef("");
const receipts = shallowRef<{ user_id?: string; status?: string; name?: string }[]>([]);
const receiptSummary = shallowRef<{ recipient_count: number; delivered_count: number; read_count: number } | null>(null);
const sourceConversation = props.message.conversation_id;
const session = chat.client.token;
let disposed = false;
const current = () => !disposed && chat.client.token === session && !chat.locked.value && chat.active.value?.id === sourceConversation;
const own = computed(() => props.message.sender_id === chat.me.value?.id);
const available = computed(() => props.message.status !== "recalled");
const canCopyImage = computed(() => !!platform.archive && !chat.locked.value && props.message.type === "image" && available.value && !!props.message.body._go_wire_id);
const canForward = computed(() => available.value && ["text", "image", "video", "file", "voice", "audio", "contact_card"].includes(props.message.type));
const canEdit = computed(() => own.value && chat.canSend.value && props.message.type === "text" && !props.message.body.poll_id && available.value);
const canRecall = computed(() => chat.me.value?.internal_staff === true && available.value);
const canPin = computed(() => available.value && chat.canSend.value &&
  (!["group", "channel"].includes(chat.active.value?.type || "") || chat.active.value?.can_manage === true));
const pinned = computed(() => chat.pins.value.some(row => row.id === props.message.id));
const timestamp = computed(() => {
  const time = Date.parse(props.message.created_at);
  if (!Number.isFinite(time)) return "时间未知";
  const today = Math.floor((Date.now() + 8 * 3600000) / 86400000);
  const day = Math.floor((time + 8 * 3600000) / 86400000);
  const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(time);
  const date = day === today ? "今天" : day === today - 1 ? "昨天" :
    new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", timeZone: "Asia/Shanghai" }).format(time);
  return `${date} ${clock}`;
});
watch([() => chat.active.value?.id, chat.locked], ([id, locked]) => { if (id !== sourceConversation || locked) emit("close"); });
onScopeDispose(() => { disposed = true; });

function permitted(operation: string) {
  switch (operation) {
    case "edit": return canEdit.value && !!draft.value.trim();
    case "recall": return canRecall.value;
    case "delete": return chat.me.value?.internal_staff === true;
    case "pin": return canPin.value;
    case "reply": return available.value && chat.canSend.value;
    case "save": return canForward.value;
    case "receipt": return own.value;
    case "copy-image": return canCopyImage.value;
    case "copy": return !!props.message.body.text && available.value;
    case "select": return true;
    default: return false;
  }
}
async function act(operation: string) {
  if (busy.value || !current() || !permitted(operation)) return;
  busy.value = true;
  copyingImage.value = operation === "copy-image";
  failure.value = "";
  try {
    if (operation === "copy") await navigator.clipboard.writeText(chat.messageText(props.message.body));
    if (operation === "copy-image") await platform.archive!.copyImage(chat.client.token,
      chat.client.wire("conversation", sourceConversation), props.message.body._go_wire_id!);
    if (operation === "reply") chat.reply.value = props.message;
    if (operation === "select") chat.selection.value = [props.message.id];
    if (operation === "edit") {
      const result = await chat.post<Message>("/messages/edit", {
        conversation_id: sourceConversation, message_id: props.message.id,
        expected_version: props.message.body._go_version, text: draft.value.trim(),
      });
      if (current()) chat.mergeMessages([result]);
    }
    if (operation === "recall") {
      const result = await chat.post<Message>("/messages/recall", { conversation_id: sourceConversation, message_id: props.message.id });
      if (current()) { chat.mergeMessages([result]); await chat.sync(); }
    }
    if (operation === "delete") {
      await chat.post("/messages/delete", { conversation_id: sourceConversation, message_ids: [props.message.id] });
      if (current()) chat.deleteLocally([props.message.id]);
    }
    if (operation === "pin") {
      await chat.post(pinned.value ? "/messages/unpin" : "/messages/pin", { conversation_id: sourceConversation, message_id: props.message.id });
      if (current()) await chat.loadPins();
    }
    if (operation === "receipt") {
      const result = await chat.api<NonNullable<typeof receiptSummary.value> & { items?: typeof receipts.value; receipts?: typeof receipts.value }>(
        `/messages/receipts?conversation_id=${sourceConversation}&message_id=${props.message.id}`);
      if (current()) {
        receipts.value = result.items || result.receipts || [];
        receiptSummary.value = result;
        showingReceipts.value = true;
      }
      return;
    }
    if (operation === "save") {
      const favorite = await chat.post<Conversation>("/conversations/favorites", {});
      if (!current()) return;
      await chat.post("/messages", { conversation_id: favorite.id, type: props.message.type,
        body: { _source_wire_id: props.message.body._go_wire_id }, request_id: "saved-" + crypto.randomUUID() });
    }
    if (current()) emit("close");
  } catch (cause) {
    if (current()) {
      failure.value = cause instanceof Error ? cause.message : "操作失败，请重试";
      if (!editor.value && !confirmation.value) chat.error(cause);
    }
  } finally { busy.value = false; copyingImage.value = false; }
}
</script>

<template>
  <ForwardPicker v-if="forwarding" :messages="[message]" @close="emit('close')" @complete="emit('close')" />
  <BaseDialog v-else-if="editor" title="编辑消息" :busy="busy" @close="emit('close')">
    <form id="edit-message-form" @submit.prevent="act('edit')">
      <textarea v-model="draft" data-dialog-autofocus aria-label="消息内容" class="message-editor" rows="5" maxlength="5000" :disabled="busy || !canEdit" />
      <p v-if="failure" role="alert">{{ failure }}</p>
    </form>
    <template #footer><button :disabled="busy" @click="emit('close')">取消</button><button type="submit" form="edit-message-form" class="primary" :disabled="busy || !canEdit || !draft.trim()">保存</button></template>
  </BaseDialog>
  <BaseDialog v-else-if="confirmation" title="删除消息" :busy="busy" size="compact" @close="emit('close')">
    <p>仅对自己删除这条消息？</p>
    <p v-if="failure" role="alert">{{ failure }}</p>
    <template #footer><button :disabled="busy" @click="emit('close')">取消</button><button class="vue-button-danger" :disabled="busy" @click="act(confirmation!)">确定</button></template>
  </BaseDialog>
  <BaseDialog v-else-if="showingReceipts" title="消息阅读回执" :busy="busy" size="compact" @close="emit('close')">
    <p>{{ chat.messagePreview(message) }}</p>
    <dl v-if="receiptSummary" class="vue-details"><dt>接收人数</dt><dd>{{ receiptSummary.recipient_count }}</dd><dt>已送达</dt><dd>{{ receiptSummary.delivered_count }}</dd><dt>已读</dt><dd>{{ receiptSummary.read_count }}</dd></dl>
    <p v-for="(receipt, index) in receipts" :key="index">{{ receipt.name || receipt.user_id }} · {{ receipt.status }}</p>
    <p v-if="!receipts.length && !receiptSummary">暂无阅读回执</p>
  </BaseDialog>
  <ContextMenu v-else label="消息操作" :point="point" @close="emit('close')">
    <button v-if="canCopyImage" role="menuitem" :disabled="busy" @click="act('copy-image')"><UiIcon name="copy" /><span aria-live="polite">{{ copyingImage ? "正在复制图片…" : "复制图片" }}</span></button>
    <button v-if="message.body.text && available" role="menuitem" :disabled="busy" @click="act('copy')"><UiIcon name="copy" />复制</button>
    <button v-if="available" role="menuitem" :disabled="busy || !chat.canSend.value" @click="act('reply')"><UiIcon name="reply" />回复</button>
    <button v-if="canForward" role="menuitem" :disabled="busy" @click="forwarding = true"><UiIcon name="forward" />转发</button>
    <button v-if="chat.me.value?.internal_staff === true" role="menuitem" :disabled="busy" @click="confirmation = 'delete'"><UiIcon name="delete" />删除</button>
    <button v-if="canPin" role="menuitem" :disabled="busy" @click="act('pin')"><UiIcon name="pin" />{{ pinned ? '取消置顶' : '置顶消息' }}</button>
    <button v-if="canEdit" role="menuitem" :disabled="busy" @click="editor = true"><UiIcon name="edit" />编辑</button>
    <button v-if="canRecall" role="menuitem" :disabled="busy" @click="act('recall')"><UiIcon name="undo" />撤回</button>
    <button role="menuitem" :disabled="busy" @click="act('select')"><UiIcon name="checkCircle" />选择此消息</button>
    <button v-if="canForward" role="menuitem" :disabled="busy" @click="act('save')"><UiIcon name="bookmark" />收藏</button>
    <button v-if="own" role="menuitem" :disabled="busy" @click="act('receipt')"><UiIcon name="eye" />阅读回执</button>
    <time class="message-menu-time" :datetime="message.created_at"><UiIcon name="history" />{{ timestamp }}</time>
  </ContextMenu>
</template>

<style scoped>
.message-editor { width: 100%; resize: vertical; min-height: 110px; padding: 10px; border: 1px solid var(--ui-line); border-radius: 5px; background: var(--ui-surface); }
[role="alert"] { color: var(--ui-danger, #c43e45); margin-top: 8px; font-size: 13px; }
</style>
