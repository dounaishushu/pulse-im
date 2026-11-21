<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from "vue";
import platform from "virtual:pulse-platform";
import { createClient, messageOf } from "../../api/client";
import type { Config } from "../../api/client";
import type { Conversation } from "../../api/types";
import { useChat } from "../../composables/useChat";
import { useConversationOutbox } from "./useConversationOutbox";
import { applyChatTheme } from "../../composables/chatTheme";
import type { ConversationWindowContext } from "../../platform/contracts";
import ChatWorkspace from "../workspace/ChatWorkspace.vue";
import SessionStartup from "../auth/SessionStartup.vue";

const { context } = defineProps<{ context: ConversationWindowContext }>();
const config = shallowRef<Config | null>(null);
const foreground = shallowRef(true);
const locked = shallowRef(false);
const startupError = shallowRef("");
const client = createClient();
const nativeWindows = platform.chatWindows!;
client.session(context.token);
const target: Conversation = {
  id: client.local("conversation", context.conversation),
  name: context.title,
  type: context.kind as Conversation["type"],
  message_seq: 0,
};
const chat = useChat(
  (cause) => { startupError.value = messageOf(cause); },
  () => { void nativeWindows.close().catch(() => {}); },
  client,
  {
    config, foreground, locked,
    logout: () => nativeWindows.close(),
    notifyOpen: () => {},
    detached: { initial: target, connected: context.connected },
  },
);
const outbox = useConversationOutbox(chat, nativeWindows, target.id);
const ready = computed(() => chat.active.value !== null && !startupError.value);
async function initialize() {
  startupError.value = "";
  await chat.initialize();
}
function close() { void nativeWindows.close().catch(() => {}); }
function reload() { window.location.reload(); }
onMounted(() => {
  void initialize();
});
watch(ready, (value) => {
  if (value) applyChatTheme(context.theme);
}, { flush: "post" });
</script>

<template>
  <ChatWorkspace v-if="ready" :chat="chat" :outbox="outbox" detached />
  <SessionStartup
    v-else
    :state="startupError ? 'error' : 'checking'"
    :error="startupError"
    desktop
    :can-switch-account="false"
    return-label="关闭窗口"
    @retry="initialize"
    @reload="reload"
    @return-to-login="close"
  />
</template>
