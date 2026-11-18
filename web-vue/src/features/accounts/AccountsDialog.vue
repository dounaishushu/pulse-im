<script setup lang="ts">
import { inject } from "vue";
import { accountsKey } from "../../composables/useSession";
import BaseDialog from "../../components/BaseDialog.vue";
import AvatarImage from "../../components/AvatarImage.vue";
const accounts = inject(accountsKey)!;
function leave(id: number, name: string) {
  if (confirm("退出账号「" + name + "」？其他账号继续在线。"))
    void accounts.logout(id);
}
</script>
<template>
  <BaseDialog
    title="已登录账号"
    :busy="accounts.busy.value"
    @close="accounts.accountsOpen.value = false"
  >
    <p v-if="accounts.notice.value" role="status">
      {{ accounts.notice.value }}
    </p>
    <ul class="vue-account-list">
      <li
        v-for="item in accounts.items.value"
        :key="item.id"
        :data-account-id="item.id"
        :data-account-connected="item.connected"
      >
        <button
          class="vue-account-choice"
          :aria-current="item.active ? 'true' : undefined"
          :disabled="accounts.busy.value"
          @click="accounts.activate(item.id)"
        >
          <AvatarImage
            :name="item.profile.nickname"
            :src="item.profile.avatar_url"
          /><span
            ><strong>{{ item.profile.nickname }}</strong
            ><small
              >{{ item.profile.username || item.profile.public_id }} ·
              {{
                item.expired
                  ? "登录已失效"
                  : item.connected
                    ? "在线"
                    : "正在连接"
              }}{{ item.active ? " · 当前账号" : "" }}</small
            ></span
          ><span v-if="item.unread" class="unread">{{
            item.unread > 99 ? "99+" : item.unread
          }}</span>
        </button>
        <button
          :disabled="accounts.busy.value"
          :aria-label="'退出账号 ' + item.profile.nickname"
          @click="leave(item.id, item.profile.nickname)"
        >
          退出
        </button>
      </li>
    </ul>
    <button
      class="primary"
      :disabled="accounts.busy.value"
      @click="accounts.addAccount()"
    >
      添加账号
    </button>
  </BaseDialog>
</template>
