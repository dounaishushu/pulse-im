<script setup lang="ts">
import { computed } from "vue";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import type { SavedAccount } from "./accountVault";

const props = defineProps<{
  profile: SavedAccount["profile"];
  active: boolean;
  connected: boolean;
  expired: boolean;
  unread: number;
  showHandle?: boolean;
}>();
const handle = computed(
  () => props.profile.username || props.profile.public_id,
);
</script>

<template>
  <span class="account-row-content flex min-w-0 items-center">
    <AvatarImage :name="profile.nickname" :src="profile.avatar_url" />
    <span class="vue-account-identity">
      <strong :title="profile.nickname">{{ profile.nickname }}</strong>
      <small
        v-if="showHandle && handle && handle !== profile.nickname"
        class="vue-account-handle"
        :title="handle"
        >{{ handle }}</small
      >
      <span
        class="vue-account-state"
        :class="{ online: connected && !expired, expired }"
      >
        {{ expired ? "登录已失效" : connected ? "在线" : "正在连接" }}
      </span>
    </span>
    <span v-if="unread" class="unread">{{ unread > 99 ? "99+" : unread }}</span>
    <span
      v-if="active"
      class="vue-account-current"
      title="当前账号"
      aria-hidden="true"
      ><UiIcon name="check"
    /></span>
  </span>
</template>

<style scoped>
.account-row-content {
  gap: 9px;
}
.account-row-content > .avatar {
  --avatar-size: 38px;
}
.vue-account-identity {
  flex: 1;
  min-width: 0;
}
.vue-account-identity :is(strong, .vue-account-handle) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vue-account-identity strong {
  font-size: 14px;
}
.vue-account-handle {
  font-size: 11px;
  color: var(--ui-muted);
}
.vue-account-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-muted);
  font-size: 11px;
}
.vue-account-state::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.vue-account-state.online {
  color: var(--ui-success);
}
.vue-account-state.expired {
  color: var(--ui-danger);
}
.vue-account-current {
  display: grid;
  flex: none;
  width: 20px;
  height: 20px;
  place-items: center;
  border-radius: 100%;
  background: var(--ui-surface);
  color: var(--ui-primary);
  font-size: 13px;
}
.unread {
  min-width: 20px;
  height: 20px;
  font-size: 11px;
}
@media (max-width: 359px) {
  .account-row-content {
    gap: 6px;
  }
  .account-row-content > .avatar {
    --avatar-size: 32px;
  }
}
</style>
