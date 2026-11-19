<script setup lang="ts">
import { computed } from "vue";
import AvatarImage from "../../components/AvatarImage.vue";
import type { SavedAccount } from "./accountVault";

const props = defineProps<{
  profile: SavedAccount["profile"];
  active: boolean;
  connected: boolean;
  expired: boolean;
  unread: number;
  showHandle?: boolean;
}>();
const handle = computed(() => props.profile.username || props.profile.public_id);
</script>

<template>
  <AvatarImage :name="profile.nickname" :src="profile.avatar_url" />
  <span class="vue-account-identity">
    <strong :title="profile.nickname">{{ profile.nickname }}</strong>
    <small
      v-if="showHandle && handle && handle !== profile.nickname"
      class="vue-account-handle"
      :title="handle"
    >
      {{ handle }}
    </small>
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
  >✓</span>
</template>
