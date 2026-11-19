<script setup lang="ts">
import { inject, shallowRef } from "vue";
import { accountsKey } from "../../composables/useSession";
import BaseDialog from "../../components/BaseDialog.vue";
import AccountIdentity from "./AccountIdentity.vue";
import UiIcon from "../../components/UiIcon.vue";
defineProps<{ showSettings: boolean }>();
const emit = defineEmits<{ settings: [] }>();
const accounts = inject(accountsKey)!;
const leaving = shallowRef<{ id: number; name: string } | null>(null);
async function leave() {
  const target = leaving.value;
  if (!target || accounts.busy.value) return;
  await accounts.logout(target.id);
  leaving.value = null;
}
</script>
<template>
  <BaseDialog
    title="已登录账号"
    layout="accounts"
    size="compact"
    :busy="accounts.busy.value"
    @close="accounts.accountsOpen.value = false"
  >
    <p v-if="accounts.notice.value" class="vue-panel-notice" role="status">
      {{ accounts.notice.value }}
    </p>
    <ul class="vue-account-list" v-if="accounts.items.value.length">
      <li
        v-for="item in accounts.items.value"
        :key="item.id"
        :data-account-id="item.id"
        :data-account-connected="item.connected"
        :class="{ 'is-current': item.active }"
      >
        <button
          class="vue-account-choice"
          type="button"
          :aria-current="item.active ? 'true' : undefined"
          :disabled="accounts.busy.value"
          @click="accounts.activate(item.id)"
        >
          <AccountIdentity
            :profile="item.profile"
            :active="item.active"
            :connected="item.connected"
            :expired="item.expired"
            :unread="item.unread"
            show-handle
          />
        </button>
        <button
          type="button"
          class="vue-button-danger vue-account-exit"
          :disabled="accounts.busy.value"
          :aria-label="'退出账号 ' + item.profile.nickname"
          @click="leaving = { id: item.id, name: item.profile.nickname }"
        >
          <UiIcon name="exit" /> <span>退出</span>
        </button>
      </li>
    </ul>
    <p v-else class="account-list-empty">暂无已登录账号</p>
    <template #footer>
      <button
        v-if="showSettings"
        type="button"
        class="vue-account-settings"
        :disabled="accounts.busy.value"
        @click="emit('settings')"
      >
        <UiIcon name="settings" /> 账户设置
      </button>
      <button
        type="button"
        class="primary semi-button semi-button-primary"
        :disabled="accounts.busy.value"
        @click="accounts.addAccount()"
      >
        <UiIcon name="plus" /> 添加账号
      </button>
    </template>
  </BaseDialog>
  <BaseDialog
    v-if="leaving"
    title="退出账号"
    size="compact"
    :busy="accounts.busy.value"
    @close="leaving = null"
  >
    <p>退出「{{ leaving.name }}」？其他账号会继续在线。</p>
    <template #footer>
      <button :disabled="accounts.busy.value" @click="leaving = null">
        取消
      </button>
      <button
        class="vue-button-danger"
        :disabled="accounts.busy.value"
        @click="leave"
      >
        确认退出
      </button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.vue-account-settings {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-inline-end: auto;
}
.vue-account-list {
  display: grid;
  gap: 7px;
  list-style: none;
  padding: 0;
  margin: 0;
}
.vue-account-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  padding: 0 7px 0 0;
  border: 1px solid var(--ui-line);
  border-radius: 7px;
}
.vue-account-list li.is-current {
  background: var(--art-active-color);
  border-color: var(--ui-selected-border);
}
.vue-account-list .vue-account-choice {
  min-width: 0;
  width: 100%;
  padding: 9px 10px;
  background: transparent;
  border-radius: 6px;
  text-align: start;
}
.vue-account-choice:hover {
  background: var(--art-hover-color);
}
.vue-account-list .vue-account-exit {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  font-size: 12px;
}
.account-list-empty {
  text-align: center;
  padding: 22px 0;
  color: var(--ui-muted);
}
@media (max-width: 359px) {
  .vue-account-list .vue-account-choice {
    padding-inline: 6px;
  }
  .vue-account-list .vue-account-exit {
    padding-inline: 7px;
  }
  .vue-account-exit .ui-icon {
    display: none;
  }
}
</style>
