<script setup lang="ts">
import { inject } from "vue";
import { accountsKey } from "../../composables/useSession";
import AccountIdentity from "./AccountIdentity.vue";
import UiIcon from "../../components/UiIcon.vue";
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
        <UiIcon name="plus" /> 添加账号
      </button>
      <button
        type="button"
        @click="
          accounts.accountsOpen.value = true;
          emit('selected');
        "
      >
        <UiIcon name="settings" /> 管理账号
      </button>
    </div>
  </section>
</template>

<style scoped>
.vue-account-switcher {
  padding-bottom: 5px;
  border-bottom: 1px solid var(--ui-line);
}
.vue-account-switcher .vue-account-choice {
  width: 100%;
  display: block;
  min-height: 50px;
  padding: 6px 8px;
  text-align: start;
}
.vue-account-choice[aria-current="true"] {
  background: var(--art-active-color);
}
.vue-account-menu-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  margin-top: 4px;
}
.vue-account-menu-actions button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-inline: 8px;
  color: var(--ui-primary);
  font-size: 12px;
}
</style>
