<script setup lang="ts">
import { inject } from "vue";
import { accountsKey } from "../../composables/useSession";
import AvatarImage from "../../components/AvatarImage.vue";
const accounts = inject(accountsKey)!;
const emit = defineEmits<{ selected: [] }>();
function activate(id: number) {
  accounts.activate(id);
  emit("selected");
}
function add() {
  accounts.addAccount();
  emit("selected");
}
</script>
<template>
  <section class="vue-account-switcher" aria-label="已登录账号">
    <button
      v-for="item in accounts.items.value"
      :key="item.id"
      :data-account-id="item.id"
      :data-account-connected="item.connected"
      :aria-current="item.active ? 'true' : undefined"
      :disabled="accounts.busy.value"
      @click="activate(item.id)"
    >
      <AvatarImage
        :name="item.profile.nickname"
        :src="item.profile.avatar_url"
      /><span
        ><strong>{{ item.profile.nickname }}</strong
        ><small>{{
          item.expired
            ? "需要重新登录"
            : item.active
              ? "当前账号"
              : item.connected
                ? "在线"
                : "正在连接"
        }}</small></span
      ><span v-if="item.unread" class="unread">{{
        item.unread > 99 ? "99+" : item.unread
      }}</span>
    </button>
    <button :disabled="accounts.busy.value" @click="add">＋ 添加账号</button>
    <button
      @click="
        accounts.accountsOpen.value = true;
        emit('selected');
      "
    >
      管理账号
    </button>
  </section>
</template>
