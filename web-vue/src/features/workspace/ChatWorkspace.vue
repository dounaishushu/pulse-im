<script setup lang="ts">
import {
  defineAsyncComponent,
  onMounted,
  onScopeDispose,
  watchEffect,
  provide,
  shallowRef,
  watch,
  useTemplateRef,
} from "vue";
import { useChat, chatKey } from "../../composables/useChat";
import ConversationSidebar from "../chat/ConversationSidebar.vue";
import MessageList from "../chat/MessageList.vue";
import MessageComposer from "../chat/MessageComposer.vue";
import MemberActions from "../chat/MemberActions.vue";
import MessageActions from "../chat/MessageActions.vue";
import BatchToolbar from "../chat/BatchToolbar.vue";
import ContactsPanel from "../contacts/ContactsPanel.vue";
import GroupDialog from "../groups/GroupDialog.vue";
import ChatSearch from "../chat/ChatSearch.vue";
import AuxiliaryPanel from "./AuxiliaryPanel.vue";
import LockScreen from "../settings/LockScreen.vue";
import BroadcastPanel from "./BroadcastPanel.vue";
import { usePreferences } from "../../composables/usePreferences";
import { useSidebarResize } from "../../composables/useSidebarResize";
import type { Message } from "../../api/types";
const SettingsDialog = defineAsyncComponent(
  () => import("../settings/SettingsDialog.vue"),
);
const emit = defineEmits<{ loginRequired: []; failed: [error: unknown] }>();
const chat = useChat(
  (error) => emit("failed", error),
  () => emit("loginRequired"),
);
provide(chatKey, chat);
const { sidebarWidth, startResize, keyboardResize } = useSidebarResize();
const preferences = usePreferences();
watchEffect(() =>
  document.body.classList.toggle(
    "vue-motion-disabled",
    !preferences.setting("animations"),
  ),
);
onScopeDispose(() =>
  document.body.classList.remove(
    "desktop-mode",
    "web-client",
    "desktop-night-mode",
  ),
);
const { active, panel, issue, locked } = chat;
const selectedMember = shallowRef<Message | null>(null);
const selectedMessage = shallowRef<Message | null>(null),
  mobileOpen = shallowRef(false);
const composer =
  useTemplateRef<InstanceType<typeof MessageComposer>>("composer");
function drop(event: DragEvent) {
  event.preventDefault();
  if (event.dataTransfer?.files.length)
    composer.value?.selectFiles([...event.dataTransfer.files]);
}
watch(chat.openRevision, () => {
  mobileOpen.value = true;
});
watch(active, (row, old) => {
  if (row?.id !== old?.id) {
    if (old?.id) panel.value = "none";
    selectedMessage.value = null;
    selectedMember.value = null;
    mobileOpen.value = !!row;
  }
});
onMounted(() => {
  document.body.classList.add("desktop-mode", "web-client");
  void chat.initialize();
  document.body.dataset.theme =
    localStorage.getItem("pulse_chat_theme") || "classic";
  document.body.classList.toggle(
    "desktop-night-mode",
    document.body.dataset.theme === "night",
  );
  document.documentElement.style.zoom =
    localStorage.getItem("pulse_interface_scale") || "1";
});
</script>
<template>
  <div
    class="vue-workspace"
    :class="{ 'mobile-chat-open': mobileOpen, 'workspace-locked': locked }"
    :style="{ '--sidebar-width': sidebarWidth + 'px' }"
    data-workspace-runtime="vue"
  >
    <ConversationSidebar @open="mobileOpen = true" />
    <div
      class="vue-sidebar-resizer"
      role="separator"
      aria-label="调整会话列表宽度"
      aria-orientation="vertical"
      tabindex="0"
      :aria-valuenow="sidebarWidth"
      :aria-valuemin="170"
      :aria-valuemax="500"
      @pointerdown="startResize"
      @keydown="keyboardResize"
    ></div>
    <BatchToolbar />
    <section class="vue-chat-main" @dragover.prevent @drop="drop">
      <template v-if="active"
        ><header class="chat-head">
          <button
            class="vue-mobile-back"
            aria-label="返回会话列表"
            @click="mobileOpen = false"
          >
            ‹
          </button>
          <div>
            <h2 :title="active.name">{{ active.name }}</h2>
            <small
              >{{ chat.connected.value ? "已连接" : "正在恢复连接"
              }}{{
                active.type === "group" &&
                active.member_count != null &&
                chat.config.value?.show_group_member_count !== false
                  ? " · " + active.member_count + " 位成员"
                  : ""
              }}</small
            >
          </div>
          <div class="vue-head-tools">
            <button aria-label="搜索聊天记录" @click="panel = 'search'">
              搜索</button
            ><button
              @click="
                chat.contactId.value = active.peer_user_id;
                chat.contactCard.value = null;
                chat.contactContext.value = undefined;
                panel =
                  active.type === 'group' || active.type === 'channel'
                    ? 'group'
                    : 'contacts';
              "
            >
              资料</button
            ><button @click="panel = 'notifications'">通知</button>
          </div>
        </header>
        <nav
          v-if="chat.pins.value.length"
          class="vue-pin-bar"
          aria-label="置顶消息"
        >
          <button
            v-for="message in chat.pins.value"
            :key="message.id"
            @click="chat.locate(message).catch(chat.error)"
          >
            📌 {{ message.body.text || "附件" }}
          </button>
        </nav>
        <MessageList
          @action="selectedMessage = $event"
          @member="selectedMember = $event" /><MessageComposer ref="composer"
      /></template>
      <div v-else class="vue-chat-empty">
        <h2>请选择会话</h2>
        <p>消息会实时同步</p>
        <button @click="panel = 'contacts'">查看联系人</button>
      </div>
    </section>
    <div v-if="issue" class="vue-global-feedback" role="alert">
      {{ issue }}<button @click="issue = ''">关闭</button
      ><button @click="chat.refresh()">重试</button>
    </div>
  </div>
  <ContactsPanel
    v-if="panel === 'contacts'"
    :user-id="chat.contactId.value"
    :card="chat.contactCard.value"
    :context-id="chat.contactContext.value"
    @close="
      panel = 'none';
      chat.contactId.value = undefined;
      chat.contactCard.value = null;
      chat.contactContext.value = undefined;
    "
  />
  <GroupDialog
    v-if="['group', 'create-group', 'create-channel', 'join'].includes(panel)"
    :mode="panel as 'group' | 'create-group' | 'create-channel' | 'join'"
    @close="panel = 'none'"
  />
  <SettingsDialog v-if="panel === 'settings'" @close="panel = 'none'" />
  <BroadcastPanel v-if="panel === 'broadcast'" @close="panel = 'none'" />
  <ChatSearch v-if="panel === 'search'" @close="panel = 'none'" />
  <AuxiliaryPanel
    v-if="panel === 'notifications' || panel === 'qr' || panel === 'calls'"
    :mode="panel"
    @close="panel = 'none'"
  />
  <MemberActions
    v-if="selectedMember"
    :message="selectedMember"
    @close="selectedMember = null"
  />
  <MessageActions
    v-if="selectedMessage"
    :message="selectedMessage"
    @close="selectedMessage = null"
  />
  <LockScreen
    v-if="locked"
    @unlocked="
      locked = false;
      chat.refresh();
    "
    @logout="chat.logout"
  />
</template>
