<script setup lang="ts">
import { inject } from "vue";
import { accountsKey } from "../../composables/useSession";
import BaseDialog from "../../components/BaseDialog.vue";
import AccountIdentity from "./AccountIdentity.vue";
const accounts = inject(accountsKey)!;
function leave(id: number, name: string) {
  if (confirm("退出账号「" + name + "」？其他账号继续在线。"))
    void accounts.logout(id);
}
</script>
<template>
  <BaseDialog
    title="已登录账号"
    size="compact"
    :busy="accounts.busy.value"
    @close="accounts.accountsOpen.value = false"
  >
    <p v-if="accounts.notice.value" class="vue-panel-notice" role="status">
      {{ accounts.notice.value }}
    </p>
    <ul class="vue-account-list">
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
          @click="leave(item.id, item.profile.nickname)"
        >
          退出
        </button>
      </li>
    </ul>
    <template #footer>
      <button
        type="button"
        class="primary"
        :disabled="accounts.busy.value"
        @click="accounts.addAccount()"
      >
        <span aria-hidden="true">＋</span> 添加账号
      </button>
    </template>
  </BaseDialog>
</template>
