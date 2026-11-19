<script setup lang="ts">
import { inject } from "vue";
import { accountsKey } from "../../composables/useSession";
import { useSettingsContext } from "./useSettings";
import AvatarImage from "../../components/AvatarImage.vue";
import SettingsNavIcon from "./SettingsNavIcon.vue";
const accounts = inject(accountsKey)!;
const { chat, titles, scale, open, setScale } = useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <div class="vue-settings-account">
      <AvatarImage
        :name="chat.me.value?.nickname"
        :src="chat.me.value?.avatar_url"
      />
      <div class="vue-settings-identity">
        <strong :title="chat.me.value?.nickname">{{ chat.me.value?.nickname }}</strong>
        <small v-if="chat.me.value?.username !== chat.me.value?.nickname">
          {{ chat.me.value?.username }}
        </small>
      </div>
      <button type="button" @click="accounts.accountsOpen.value = true">切换或添加账号</button>
    </div>
    <nav class="vue-settings-menu" aria-label="设置分类">
      <button
        v-for="item in [
          'profile',
          'notifications',
          'privacy',
          'chat',
          'media',
          'advanced',
          'language',
          'password',
          'security',
          'help',
        ] as const"
        :key="item"
        type="button"
        class="vue-settings-link"
        @click="open(item)"
      >
        <SettingsNavIcon :name="item" />
        <span>{{ titles[item] }}</span>
      </button>
    </nav>
    <label class="vue-settings-scale"
      >默认界面缩放<select v-model.number="scale" @change="setScale">
        <option
          v-for="value in [1, 1.25, 1.5, 2, 2.5, 3]"
          :key="value"
          :value="value"
        >
          {{ value * 100 }}%
        </option>
      </select></label
    ><button type="button" class="vue-button-danger" @click="chat.logout">退出登录</button>
  </div>
</template>

<style scoped>
.vue-settings-account {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 0 14px;
  border-bottom: 1px solid var(--panel-line);
  flex-wrap: wrap;
}
.vue-settings-account .avatar {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  border-radius: 50%;
}
.vue-settings-identity { flex: 1; min-width: 5ch; }
.vue-settings-identity :is(strong, small) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vue-settings-identity small { color: var(--panel-muted); }
.vue-settings-menu { display: grid; margin: 6px 0 0; }
.vue-settings-menu .vue-settings-link {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding-inline: 10px;
  background: transparent;
  text-align: left;
  border-bottom: 1px solid var(--panel-line);
  border-radius: 0;
}
.vue-settings-link svg { flex: none; color: var(--panel-muted); }
.vue-settings-link span { flex: 1; min-width: 0; }
.vue-settings-link:hover { background: var(--panel-soft); }
.vue-settings-link::after {
  content: "";
  flex: 0 0 6px;
  height: 6px;
  border: solid var(--panel-muted);
  border-width: 1.5px 1.5px 0 0;
  transform: rotate(45deg);
  margin-inline-end: 4px;
}
.vue-settings-scale {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  margin: 14px 0;
}
.vue-settings-scale select { width: auto; }
</style>
