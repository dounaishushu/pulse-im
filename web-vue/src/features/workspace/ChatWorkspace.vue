<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onScopeDispose,
  watchEffect,
  provide,
  shallowRef,
  watch,
  useTemplateRef,
} from "vue";
import { chatKey, type Chat } from "../../composables/useChat";
import WorkspaceNavigation from "./WorkspaceNavigation.vue";
import ConversationSidebar from "../chat/ConversationSidebar.vue";
import ConversationHeader from "../chat/ConversationHeader.vue";
import UiIcon from "../../components/UiIcon.vue";
import WorkspaceWelcome from "./WorkspaceWelcome.vue";
import MessageList from "../chat/MessageList.vue";
import { outboxKey, type TextOutbox } from "../chat/useOutbox";
import MessageComposer from "../chat/MessageComposer.vue";
import MemberActions from "../chat/MemberActions.vue";
import MessageActions from "../chat/MessageActions.vue";
import BatchToolbar from "../chat/BatchToolbar.vue";
import ContactsPanel from "../contacts/ContactsPanel.vue";
import GroupDialog from "../groups/GroupDialog.vue";
import GroupSidebar from "../groups/GroupSidebar.vue";
import ChatSearch from "../chat/ChatSearch.vue";
import AuxiliaryPanel from "./AuxiliaryPanel.vue";
import NotificationCenter from "./NotificationCenter.vue";
import LockScreen from "../settings/LockScreen.vue";
import BroadcastPanel from "./BroadcastPanel.vue";
import { usePreferences } from "../../composables/usePreferences";
import { useSidebarResize } from "../../composables/useSidebarResize";
import { applyChatTheme } from "../../composables/chatTheme";
import type { Conversation, Member, Message } from "../../api/types";
import type { MemberSocialAction } from "../groups/memberActions";
const SettingsDialog = defineAsyncComponent(
  () => import("../settings/SettingsDialog.vue"),
);
const props = defineProps<{ chat: Chat; outbox: TextOutbox }>();
const chat = props.chat;
provide(outboxKey, props.outbox);
provide(chatKey, chat);
const { sidebarWidth, startResize, keyboardResize } = useSidebarResize();
const preferences = usePreferences();
watchEffect(() =>
  document.body.classList.toggle(
    "vue-motion-disabled",
    !preferences.setting("animations"),
  ),
);
onScopeDispose(() => {
  document.body.classList.remove(
    "desktop-mode",
    "web-client",
    "desktop-night-mode",
    "vue-motion-disabled",
  );
  document.body.removeAttribute("theme-mode");
  document.documentElement.style.colorScheme = "";
});
const { active, panel, issue, locked } = chat;
const wideLayout = window.matchMedia("(min-width: 1080px)");
const wide = shallowRef(wideLayout.matches);
const desktopGroup = computed(
  () => wide.value && active.value?.type === "group",
);
const groupRevision = shallowRef(0);
const groupSection = shallowRef<"profile" | "members" | "manage">("profile");
const groupInvite = shallowRef(false);
const headerBusy = shallowRef(false);
watch(panel, (next, previous) => {
  if (previous === "group" && next !== "group") {
    groupSection.value = "profile";
    groupInvite.value = false;
  }
});
const memberFriendRequest = shallowRef(false);
let memberChatPending = false;
async function openMemberAction(action: MemberSocialAction, member: Member) {
  const origin = active.value?.id;
  if (!origin) return;
  if (action === "chat") {
    if (memberChatPending) return;
    memberChatPending = true;
    try {
      const direct = await chat.post<Conversation>("/conversations/direct", { user_id: member.id });
      if (active.value?.id !== origin) return;
      panel.value = "none";
      await chat.choose(direct.id);
    } catch (cause) {
      if (active.value?.id === origin) chat.error(cause);
    } finally {
      memberChatPending = false;
    }
    return;
  }
  memberFriendRequest.value = action === "add";
  chat.contactId.value = member.id;
  chat.contactCard.value = null;
  chat.contactContext.value = member.is_contact || member.id === chat.me.value?.id ? undefined : origin;
  panel.value = "contacts";
}
watch(panel, (value) => {
  if (value !== "contacts") memberFriendRequest.value = false;
});
const updateLayout = () => {
  wide.value = wideLayout.matches;
};
wideLayout.addEventListener("change", updateLayout);
onScopeDispose(() => wideLayout.removeEventListener("change", updateLayout));
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
function openContacts(next: "contacts" | "add-contact") {
  chat.contactId.value = undefined;
  chat.contactCard.value = null;
  chat.contactContext.value = undefined;
  panel.value = next;
}
function openDetails() {
  const row = active.value;
  if (!row) return;
  chat.contactId.value = row.peer_user_id;
  chat.contactCard.value = null;
  chat.contactContext.value = undefined;
  panel.value =
    row.type === "group" || row.type === "channel" ? "group" : "contacts";
}
async function headerAction(action: "manage" | "invite" | "mute" | "clear") {
  const row = active.value;
  if (!row || headerBusy.value) return;
  if (action === "manage" || action === "invite") {
    groupSection.value = action === "manage" ? "manage" : "members";
    groupInvite.value = action === "invite";
    panel.value = "group";
    return;
  }
  headerBusy.value = true;
  try {
    if (action === "mute") {
      await chat.mutate("/conversations/settings", {
        conversation_id: row.id,
        notifications_muted: !row.notifications_muted,
      });
    } else if (chat.me.value?.internal_staff && confirm("清空自己在此会话中的历史记录？")) {
      await chat.mutate("/messages/clear-history", {
        conversation_id: row.id,
        through_message_id: row.message_seq,
      });
    }
  } catch (cause) {
    if (active.value?.id === row.id) chat.error(cause);
  } finally {
    headerBusy.value = false;
  }
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

  applyChatTheme(localStorage.getItem("pulse_chat_theme") || "classic");
  document.documentElement.style.zoom =
    localStorage.getItem("pulse_interface_scale") || "1";
});
</script>
<template>
  <div
    class="vue-workspace"
    :class="{
      'mobile-chat-open': mobileOpen,
      'workspace-locked': locked,
    }"
    :style="{ '--sidebar-width': sidebarWidth + 'px' }"
    data-workspace-runtime="vue"
  >
    <WorkspaceNavigation @list="mobileOpen = false" />
    <ConversationSidebar
      @open="mobileOpen = true"
      @add-contact="openContacts('add-contact')"
    />
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
    <section class="vue-chat-main" :class="{ 'desktop-group': desktopGroup }">
      <template v-if="active">
        <ConversationHeader
          :conversation="active"
          :desktop-group="desktopGroup"
          :can-clear="chat.me.value?.internal_staff === true"
          :busy="headerBusy"
          :show-member-count="
            chat.config.value?.show_group_member_count !== false
          "
          @back="mobileOpen = false"
          @search="panel = 'search'"
          @details="openDetails"
          @more="headerAction"
          @notifications="panel = 'notifications'"
        />
        <div class="vue-chat-stream" @dragover.prevent @drop="drop">
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
              <UiIcon name="bookmark" /> {{ message.body.text || "附件" }}
            </button>
          </nav>
          <MessageList
            :desktop-group="desktopGroup"
            @action="selectedMessage = $event"
            @member="selectedMember = $event"
          />
          <MessageComposer ref="composer" :desktop="wide" />
        </div>
        <GroupSidebar
          v-if="desktopGroup"
          :key="active.id"
          :conversation="active"
          :show-member-count="
            chat.config.value?.show_group_member_count !== false
          "
          :refresh-revision="groupRevision"
          @member="openMemberAction"
          @updated="groupRevision++"
        />
      </template>
      <WorkspaceWelcome v-else @contacts="openContacts('contacts')" />
    </section>
    <GroupDialog
      v-if="['group', 'create-group', 'create-channel', 'join'].includes(panel)"
      :key="panel"
      :mode="panel as 'group' | 'create-group' | 'create-channel' | 'join'"
      @updated="groupRevision++"
      :initial-section="groupSection"
      :open-invite="groupInvite"
      @member="openMemberAction"
      @close="panel = 'none'"
    />
    <div v-if="issue" class="vue-global-feedback" role="alert">
      {{ issue }}<button @click="issue = ''">关闭</button
      ><button @click="chat.refresh()">重试</button>
    </div>
  </div>
  <ContactsPanel
    v-if="panel === 'contacts' || panel === 'add-contact'"
    :key="panel"
    :initial-section="panel === 'add-contact' ? 'search' : undefined"
    :initial-request="memberFriendRequest"
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
  <SettingsDialog
    v-if="panel === 'settings' || panel === 'media-settings'"
    :key="panel"
    :open-media="panel === 'media-settings'"
    @close="panel = panel === 'media-settings' ? 'calls' : 'none'"
  />
  <BroadcastPanel v-if="panel === 'broadcast'" @close="panel = 'none'" />
  <ChatSearch v-if="panel === 'search'" @close="panel = 'none'" />
  <NotificationCenter
    v-if="panel === 'notifications'"
    @close="panel = 'none'"
  />
  <AuxiliaryPanel
    v-if="panel === 'qr' || panel === 'calls'"
    :mode="panel"
    @close="panel = 'none'"
    @open-media-settings="panel = 'media-settings'"
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

<style scoped>
.vue-workspace {
  --rail-width: 72px;
  --mobile-rail-height: 60px;
  --identity-height: 76px;
  --workspace-rail-surface: color-mix(
    in srgb, var(--ui-rail-bg) 68%, var(--ui-surface)
  );
  --workspace-list-surface: color-mix(
    in srgb, var(--ui-sidebar) 42%, var(--ui-surface)
  );
  display: grid;
  grid-template:
    var(--identity-height) minmax(0, 1fr) / var(--rail-width) min(
      var(--sidebar-width, 334px),
      43vw
    )
    minmax(0, 1fr);
  position: relative;
  height: 100dvh;
  overflow: hidden;
  background: var(--ui-canvas);
}
.vue-sidebar-resizer {
  position: absolute;
  inset: 0 auto 0
    calc(var(--rail-width) + min(var(--sidebar-width, 334px), 43vw) - 3px);
  width: 6px;
  cursor: col-resize;
  z-index: 5;
  touch-action: none;
}
.vue-sidebar-resizer:focus-visible,
.vue-sidebar-resizer:active {
  background: var(--ui-focus);
  outline-offset: -2px;
}
.workspace-locked {
  visibility: hidden;
}

@media (max-width: 760px) {
  .vue-workspace {
    --identity-height: 54px;
    grid-template:
      var(--identity-height) minmax(0, 1fr) calc(
        var(--mobile-rail-height) + env(safe-area-inset-bottom)
      )
      / minmax(0, 1fr);
  }
  .vue-sidebar-resizer,
  .vue-workspace .vue-chat-main {
    display: none;
  }
  .vue-workspace.mobile-chat-open :deep(.workspace-identity),
  .vue-workspace.mobile-chat-open :deep(.workspace-rail),
  .vue-workspace.mobile-chat-open :deep(.vue-sidebar) {
    display: none;
  }
  .vue-workspace.mobile-chat-open .vue-chat-main {
    display: flex;
    grid-area: 1 / 1 / -1 / -1;
  }
}
.vue-chat-main {
  grid-area: 1 / 3 / -1 / -1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--ui-canvas);
}
.vue-chat-stream {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.vue-chat-main.desktop-group {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(188px, 16vw, 232px);
  grid-template-rows: auto minmax(0, 1fr);
}
.desktop-group > :deep(.chat-head) {
  grid-column: 1 / -1;
}
.desktop-group > .vue-chat-stream {
  grid-area: 2 / 1;
}
.desktop-group > :deep(.group-sidebar) {
  grid-area: 2 / 2;
}
.vue-pin-bar {
  display: flex;
  gap: 6px;
  padding: 6px 12px;
  overflow-x: auto;
  background: var(--ui-surface-soft);
  border-bottom: 1px solid var(--ui-line);
  flex: none;
  scrollbar-width: thin;
}
.vue-pin-bar button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: min(480px, 100%);
  flex: none;
  font-size: 12px;
  color: var(--ui-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
