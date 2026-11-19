<script setup lang="ts">
import { inject } from "vue";
import { accountsKey } from "../../composables/useSession";
import AccountIdentity from "./AccountIdentity.vue";
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
      type="button"
      class="vue-account-choice"
      :data-account-id="item.id"
      :data-account-connected="item.connected"
      :aria-current="item.active ? 'true' : undefined"
      :disabled="accounts.busy.value"
      @click="activate(item.id)"
    >
      <AccountIdentity
        :profile="item.profile"
        :active="item.active"
        :connected="item.connected"
        :expired="item.expired"
        :unread="item.unread"
      />
    </button>
    <div class="vue-account-menu-actions">
      <button type="button" :disabled="accounts.busy.value" @click="add">
        <span aria-hidden="true">＋</span> 添加账号
      </button>
      <button
        type="button"
        @click="
          accounts.accountsOpen.value = true;
          emit('selected');
        "
      >
        管理账号
      </button>
    </div>
  </section>
</template>
