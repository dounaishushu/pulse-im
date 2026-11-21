<script setup lang="ts">
import { inject, onScopeDispose, shallowRef } from "vue";
import { chatKey } from "../../composables/useChat";
import { outboxKey } from "../chat/useOutbox";
import { readChatTransfer, recoveredDraftKey } from "./legacyChatTransfer";

const chat = inject(chatKey)!;
const outbox = inject(outboxKey)!;
const expanded = shallowRef(false);
const file = shallowRef<File>();
const passphrase = shallowRef("");
const status = shallowRef("");
const error = shallowRef("");
const busy = shallowRef(false);
let alive = true;

function choose(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0];
  error.value = "";
}

async function restore() {
  const source = file.value;
  const user = chat.me.value?.id;
  const token = chat.client.token;
  if (!source || !user || !token || busy.value || !outbox.importForReview || chat.locked.value) return;
  const current = () => alive && !chat.locked.value && !chat.updateSuspended.value && chat.client.token === token && chat.me.value?.id === user;
  busy.value = true;
  error.value = "";
  status.value = "";
  try {
    const wireUser = chat.client.wire("user", user);
    const { pending, drafts } = await readChatTransfer(source, passphrase.value, chat.client, wireUser, current);
    const pendingCount = pending.length ? await outbox.importForReview(pending) : 0;
    if (!current()) return;
    const restored = new Set<number>();
    const previews = { ...chat.drafts.value };
    let draftError = false;
    for (const [conversation, draft] of drafts) {
      const key = recoveredDraftKey(user, conversation);
      if (previews[conversation] || localStorage.getItem(key)) continue;
      try {
        localStorage.setItem(key, JSON.stringify({ ...draft, mentions: [], all: false }));
      } catch {
        draftError = true;
        break;
      }
      previews[conversation] = draft.text;
      restored.add(conversation);
    }
    if (restored.size) {
      chat.drafts.value = previews;
      window.dispatchEvent(new CustomEvent("pulse:drafts-imported", { detail: restored }));
    }
    status.value = `已恢复 ${restored.size} 份草稿和 ${pendingCount} 条待发消息。${pendingCount ? "请打开对应会话确认发送。" : ""}`;
    if (draftError) error.value = "本机空间不足，剩余草稿未能保存。";
    if (!draftError) expanded.value = false;
  } catch (cause) {
    if (current()) error.value = cause instanceof Error ? cause.message : "暂时无法恢复聊天备份。";
  } finally {
    passphrase.value = "";
    busy.value = false;
  }
}

onScopeDispose(() => {
  alive = false;
  passphrase.value = "";
  file.value = undefined;
});
</script>

<template>
  <section v-if="outbox.importForReview" class="chat-restore">
    <button type="button" :aria-expanded="expanded" :disabled="busy" @click="expanded = !expanded">
      恢复旧版草稿和待发消息
    </button>
    <form v-if="expanded" class="vue-fields" @submit.prevent="restore">
      <label>备份文件<input type="file" accept=".pulse-chat" :disabled="busy" required @change="choose" /></label>
      <label>备份密码<input v-model="passphrase" type="password" autocomplete="off" minlength="10" maxlength="128" :disabled="busy" required /></label>
      <button type="submit" class="primary" :disabled="busy">{{ busy ? "正在恢复…" : "恢复聊天备份" }}</button>
    </form>
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.chat-restore { display: grid; justify-items: start; gap: 8px; }
.chat-restore p { margin: 0; }
</style>
