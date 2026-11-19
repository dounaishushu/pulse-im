<script setup lang="ts">
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import type { Conversation } from "../../api/types";

defineProps<{
  conversation: Conversation;
  showMemberCount: boolean;
  desktopGroup?: boolean;
}>();
const emit = defineEmits<{
  back: [];
  search: [];
  details: [];
  notifications: [];
}>();
</script>

<template>
  <header
    class="chat-head flex items-center"
    :class="{ 'chat-head-group': desktopGroup }"
  >
    <button
      type="button"
      class="vue-mobile-back ui-icon-button"
      aria-label="返回会话列表"
      title="返回会话列表"
      @click="emit('back')"
    >
      <UiIcon name="back" />
    </button>
    <div class="conversation-heading flex flex-1 min-w-0 items-center gap-3">
      <AvatarImage :name="conversation.name" :src="conversation.avatar_url" />
      <div class="min-w-0">
        <h2 :title="conversation.name" class="truncate">
          {{ conversation.name }}
        </h2>
        <small
          v-if="
            conversation.type === 'group' &&
            !desktopGroup &&
            showMemberCount &&
            conversation.member_count != null
          "
        >
          {{ conversation.member_count }} 位成员
        </small>
        <small
          v-else-if="conversation.peer_online === true"
          class="conversation-peer-online"
          >在线</small
        >
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
        :aria-label="desktopGroup ? '群资料与管理' : '资料'"
        :title="desktopGroup ? '群资料与管理' : '查看资料'"
        @click="emit('details')"
      >
        <UiIcon name="more" />
      </button>
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
.vue-head-tools .ui-icon-button {
  font-size: 21px;
}
.chat-head-group {
  padding-inline: 18px 14px;
}
.chat-head-group .avatar {
  --avatar-size: 32px;
}
.chat-head-group .vue-head-tools .ui-icon-button {
  width: 36px;
  height: 36px;
  font-size: 19px;
}
.chat-head .vue-mobile-back {
  display: none;
  font-size: 22px;
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
