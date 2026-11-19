<script setup lang="ts">
import { inject } from "vue";
import { accountsKey } from "../../composables/useSession";
import { useSettingsContext } from "./useSettings";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
const accounts = inject(accountsKey)!;
const { chat, scale, setScale } = useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <div class="vue-settings-account settings-card">
      <AvatarImage
        :name="chat.me.value?.nickname"
        :src="chat.me.value?.avatar_url"
      />
      <div class="vue-settings-identity">
        <strong :title="chat.me.value?.nickname">{{
          chat.me.value?.nickname
        }}</strong>
        <small v-if="chat.me.value?.username !== chat.me.value?.nickname">
          {{ chat.me.value?.username }}
        </small>
      </div>
      <button type="button" @click="accounts.accountsOpen.value = true">
        <UiIcon name="profile" /> 切换或添加账号
      </button>
    </div>
    <label class="vue-settings-scale settings-card"
      >默认界面缩放<select v-model.number="scale" @change="setScale">
        <option
          v-for="value in [1, 1.25, 1.5, 2, 2.5, 3]"
          :key="value"
          :value="value"
        >
          {{ value * 100 }}%
        </option>
      </select></label
    ><button type="button" class="vue-button-danger" @click="chat.logout">
      <UiIcon name="exit" /> 退出登录
    </button>
  </div>
</template>

<style scoped>
.vue-settings-account {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.settings-card {
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-line);
}
.vue-settings-account .avatar {
  --avatar-size: 44px;
}
.vue-settings-identity {
  flex: 1;
  min-width: 5ch;
}
.vue-settings-identity :is(strong, small) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vue-settings-identity small {
  color: var(--panel-muted);
}
.vue-settings-section .vue-settings-scale {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  margin: 14px 0;
}
.vue-settings-scale select {
  width: auto;
}
.vue-settings-account button,
.vue-settings-section > .vue-button-danger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
