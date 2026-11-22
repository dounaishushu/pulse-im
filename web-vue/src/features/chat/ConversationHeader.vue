<script setup lang="ts">
import { computed, inject, onScopeDispose, shallowRef, useTemplateRef, watch } from "vue";
import platform from "virtual:pulse-platform";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import type { ContactAudit, Conversation } from "../../api/types";
import { chatKey } from "../../composables/useChat";
import { ipLocationSource, ipLocationText } from "../contacts/ipLocation";

const props = defineProps<{
  conversation: Conversation;
  showMemberCount: boolean;
  desktopGroup?: boolean;
  groupSidebarOpen?: boolean;
  detached?: boolean;
  canClear?: boolean;
  showArchive?: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{
  back: [];
  search: [];
  archive: [];
  details: [];
  toggleGroupInfo: [];
  notifications: [];
  more: [action: "manage" | "invite" | "mute" | "clear"];
}>();
const chat = inject(chatKey, undefined);
const audit = shallowRef<ContactAudit | null>(null);
let auditRequest: AbortController | undefined;
let disposed = false;
const location = computed(() => ipLocationText(audit.value?.last_login_ip, audit.value?.last_login_location,
  audit.value?.last_login_location_status, audit.value?.last_login_location_detail));
const networkTitle = computed(() => audit.value ? `最近成功登录 IP：${audit.value.last_login_ip || '暂无记录'} · ${location.value}\n${ipLocationSource(audit.value.last_login_location_detail)}` : "");
watch([() => props.conversation.id, () => props.conversation.peer_user_id, () => props.conversation.type,
  () => chat?.me.value?.internal_staff, () => chat?.locked.value, () => chat?.client.token], async () => {
  auditRequest?.abort();
  auditRequest = undefined;
  audit.value = null;
  const peer = props.conversation.peer_user_id;
  if (!chat || chat.locked.value || chat.me.value?.internal_staff !== true || props.conversation.type !== "direct" || !peer) return;
  const request = auditRequest = new AbortController();
  const token = chat.client.token;
  try {
    const details = await chat.api<ContactAudit>(`/contacts/internal-profile?user_id=${peer}`, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
    });
    if (!disposed && auditRequest === request && !request.signal.aborted && chat.client.token === token &&
      chat.me.value?.internal_staff === true && !chat.locked.value && details.user_id === peer) audit.value = details;
  } catch (cause) {
    if (!disposed && auditRequest === request && !request.signal.aborted && [401, 426].includes((cause as { status?: number }).status ?? 0)) chat.error(cause);
  }
}, { immediate: true, flush: "sync" });
onScopeDispose(() => { disposed = true; auditRequest?.abort(); auditRequest = undefined; });
const displayName = computed(() => chat?.conversationName(props.conversation) || props.conversation.name);
const presence = computed(() => {
  const row = props.conversation;
  if (row.type !== "direct") return "";
  if (platform.name === "pc" && row.peer_last_seen_hidden) return "最后上线时间已隐藏";
  if (row.peer_online === true) return "在线";
  if (platform.name !== "pc" || row.peer_online !== false) return "";
  const last = row.peer_last_seen_at ? Date.parse(row.peer_last_seen_at) : NaN;
  return Number.isFinite(last)
    ? `离线 · 最近在线 ${new Date(last).toLocaleString("zh-CN", { hour12: false })}`
    : "离线";
});
const menu = useTemplateRef<HTMLElement>("menu");
const menuButton = useTemplateRef<HTMLButtonElement>("menuButton");
function closeMore(restoreFocus = false) {
  if (menu.value?.matches(":popover-open")) menu.value.hidePopover();
  if (restoreFocus) menuButton.value?.focus();
}
watch(() => props.conversation.id, () => closeMore());
function runMore(action: "manage" | "invite" | "mute" | "clear") {
  closeMore(true);
  emit("more", action);
}
</script>

<template>
  <header
    class="chat-head flex items-center"
    :class="{ 'chat-head-group': conversation.type === 'group' }"
  >
    <button
      type="button"
      v-if="!detached"
      class="vue-mobile-back ui-icon-button"
      aria-label="返回会话列表"
      title="返回会话列表"
      @click="emit('back')"
    >
      <UiIcon name="back" />
    </button>
    <div class="conversation-heading flex flex-1 min-w-0 items-center gap-3">
      <button
        v-if="conversation.type === 'direct' && conversation.peer_user_id"
        type="button"
        class="conversation-profile-avatar"
        :aria-label="'查看' + displayName + '的资料'"
        title="查看个人资料"
        :disabled="busy || chat?.locked.value"
        @click="emit('details')"
      ><AvatarImage :name="displayName" :src="conversation.avatar_url" :media-id="conversation.avatar_id" /></button>
      <AvatarImage v-else :name="displayName" :src="conversation.avatar_url" :media-id="conversation.avatar_id" />
      <div class="min-w-0">
        <h2 :title="displayName" class="truncate">
          {{ displayName }}
        </h2>
        <div class="conversation-subtitle">
        <small
          v-if="
            conversation.type === 'group' &&
            showMemberCount &&
            conversation.member_count != null
          "
        >
          {{ conversation.member_count }} 位成员
        </small>
        <small
          v-else-if="presence"
          class="truncate"
          :class="{ 'conversation-peer-online': conversation.peer_online === true }"
          :title="presence"
          >{{ presence }}</small
        >
        <small v-if="audit && chat?.me.value?.internal_staff && !chat.locked.value" class="conversation-peer-network truncate" :title="networkTitle">
          IP：{{ audit.last_login_ip || '暂无记录' }} · 归属地：{{ location }}
        </small>
        </div>
      </div>
    </div>
    <div class="vue-head-tools flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="ui-icon-button"
        aria-label="搜索聊天记录"
        title="搜索聊天记录"
        @click="emit('search')"
      >
        <UiIcon :name="desktopGroup ? 'search' : 'history'" />
      </button>
      <button
        type="button"
        v-if="!detached"
        class="ui-icon-button conversation-notifications"
        aria-label="通知"
        title="通知"
        @click="emit('notifications')"
      >
        <UiIcon name="bell" />
      </button>
      <button
        type="button"
        class="ui-icon-button"
        :aria-label="desktopGroup ? groupSidebarOpen ? '收起群组信息' : '展开群组信息' : '资料'"
        :title="desktopGroup ? groupSidebarOpen ? '收起群组信息' : '展开群组信息' : '查看资料'"
        :aria-expanded="desktopGroup ? groupSidebarOpen === true : undefined"
        :aria-controls="desktopGroup ? 'group-sidebar-panel' : undefined"
        @click="desktopGroup ? emit('toggleGroupInfo') : emit('details')"
      >
        <UiIcon :name="desktopGroup ? 'group' : 'info'" />
      </button>
      <button
        ref="menuButton"
        class="ui-icon-button"
        type="button"
        aria-label="更多操作"
        title="更多操作"
        popovertarget="conversation-more"
        :disabled="busy"
      >
        <UiIcon name="more" />
      </button>
      <div id="conversation-more" ref="menu" class="conversation-more" popover
        role="group" aria-label="会话操作" @keydown.esc.stop.prevent="closeMore(true)">
        <button type="button" @click="closeMore(true); emit('search')">
          <UiIcon name="search" /> 搜索聊天记录
        </button>
        <button v-if="showArchive" type="button" @click="closeMore(true); emit('archive')">
          <UiIcon name="history" /> 聊天记录
        </button>
        <button type="button" @click="closeMore(true); emit('details')">
          <UiIcon name="info" /> 查看资料
        </button>
        <template v-if="conversation.type === 'group' || conversation.type === 'channel'">
          <button type="button" @click="runMore('mute')">
            <UiIcon name="bell" /> {{ conversation.notifications_muted ? "开启消息通知" : "关闭消息通知" }}
          </button>
          <button v-if="conversation.can_invite || conversation.can_manage" type="button" @click="runMore('invite')">
            <UiIcon name="userAdd" /> 邀请新成员
          </button>
          <button v-if="conversation.can_manage" type="button" @click="runMore('manage')">
            <UiIcon name="settings" /> 管理群组
          </button>
        </template>
        <button v-if="canClear && conversation.message_seq > 0" type="button"
          class="conversation-more-danger" @click="runMore('clear')">
          <UiIcon name="delete" /> 清空历史记录
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.chat-head {
  min-height: 62px;
  flex: none;
  gap: 10px;
  padding: 8px 17px;
  border-bottom: 1px solid var(--ui-line);
  background: var(--ui-surface);
}
.chat-head .avatar {
  --avatar-size: 35px;
}
.chat-head .conversation-profile-avatar {
  display: inline-flex;
  flex: none;
  padding: 0;
  border-radius: var(--avatar-radius, 7px);
  background: transparent;
}
.chat-head .conversation-profile-avatar:not(:disabled):hover {
  background: transparent;
}
.chat-head h2 {
  font-size: var(--ui-font-content);
  line-height: var(--ui-line-heading);
  font-weight: var(--ui-weight-strong);
}
.chat-head small {
  display: block;
  margin-top: 2px;
  font-size: var(--ui-font-caption);
  color: var(--ui-muted);
}
.chat-head .conversation-peer-online {
  color: var(--ui-success);
}
.conversation-subtitle { display: flex; align-items: center; flex-wrap: wrap; column-gap: 10px; min-width: 0; }
.conversation-peer-network { max-width: 100%; font-variant-numeric: tabular-nums; }
.vue-head-tools .ui-icon-button {
  font-size: 21px;
}
.chat-head-group {
  padding-inline: 18px 14px;
}
.chat-head-group .avatar {
  --avatar-size: 38px;
  --avatar-radius: 50%;
}
.chat-head-group h2 { font-size: 16px; line-height: 1.35; }
.chat-head-group small { font-size: 12px; line-height: 1.35; margin-top: 3px; }
.chat-head-group .vue-head-tools .ui-icon-button {
  width: 36px;
  height: 36px;
  font-size: 19px;
}
.chat-head .vue-mobile-back {
  display: none;
  font-size: 22px;
}
.conversation-more {
  inset: 56px 12px auto auto;
  margin: 0;
  padding: 4px;
  width: 168px;
  max-width: calc(100vw - 24px);
  color: var(--ui-text);
  border: 1px solid var(--ui-line);
  border-radius: 8px;
  background: var(--ui-surface);
  box-shadow: var(--ui-popover-shadow);
}
.conversation-more button {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 8px;
  min-height: 36px;
  padding: 6px 8px;
  background: transparent;
  text-align: start;
}
.conversation-more .conversation-more-danger {
  color: var(--ui-danger);
}
.chat-head .conversation-notifications {
  display: none;
}
@media (max-width: 760px) {
  .chat-head .conversation-notifications {
    display: inline-flex;
  }
  .chat-head {
    min-height: 54px;
    padding: 6px 8px;
    gap: 4px;
  }
  .conversation-heading {
    gap: 7px;
  }
  .chat-head .avatar {
    --avatar-size: 29px;
  }
  .chat-head .vue-mobile-back {
    display: inline-flex;
    width: 31px;
  }
  .vue-head-tools .ui-icon-button {
    height: 37px;
    width: 33px;
  }
}
</style>
