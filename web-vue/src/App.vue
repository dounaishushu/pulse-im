<script setup lang="ts">
import {
  defineAsyncComponent,
  onMounted,
  onErrorCaptured,
  onScopeDispose,
  provide,
} from "vue";
import icon from "./assets/pulse-mark.webp";
import AuthView from "./features/auth/AuthView.vue";
import AccountsDialog from "./features/accounts/AccountsDialog.vue";
import { useSession, accountsKey } from "./composables/useSession";
const session = useSession();
provide(accountsKey, session);
const location = window.location;
const Workspace = defineAsyncComponent(
  () => import("./features/workspace/ChatWorkspace.vue"),
);
const preloadFailed = (event: Event) => {
  event.preventDefault();
  session.failed(Error("页面资源已更新，请刷新后加载新版。"));
};
window.addEventListener("vite:preloadError", preloadFailed);
onScopeDispose(() =>
  window.removeEventListener("vite:preloadError", preloadFailed),
);
onMounted(() => {
  void session.enter();
});
onErrorCaptured((error) => {
  session.failed(error);
  return false;
});
</script>

<template>
  <AuthView
    v-if="session.phase.value === 'login'"
    :key="session.loginAccount.value + ':' + session.adding.value"
    :initial-account="session.loginAccount.value"
    :session-busy="session.busy.value"
    :require-avatar="session.config.value?.register_require_avatar === true"
    @authenticated="session.authenticated"
  />
  <div
    v-if="
      session.phase.value === 'login' &&
      session.items.value.some((item) => !item.expired)
    "
    class="vue-account-return"
  >
    <button :disabled="session.busy.value" @click="session.cancelAdd()">
      返回已登录账号
    </button>
  </div>
  <p
    v-if="session.error.value && session.phase.value === 'login'"
    class="vue-global-feedback"
    role="alert"
  >
    {{ session.error.value }}
  </p>
  <Workspace
    v-if="session.phase.value === 'workspace' && session.current.value"
    :key="session.activeId.value + ':' + session.current.value.key"
    :chat="session.current.value.chat"
    :outbox="session.current.value.outbox"
    @failed="session.failed"
  />
  <AccountsDialog v-if="session.accountsOpen.value && !session.locked.value" />
  <p
    v-if="
      session.notice.value &&
      session.phase.value === 'workspace' &&
      !session.accountsOpen.value
    "
    class="vue-account-notice"
    role="status"
  >
    {{ session.notice.value
    }}<button @click="session.notice.value = ''">关闭</button>
  </p>
  <main
    v-if="session.phase.value === 'checking' || session.phase.value === 'error'"
    class="startup-state"
    aria-live="polite"
  >
    <img :src="icon" alt="" width="48" height="48" />
    <template v-if="session.phase.value === 'error'"
      ><h1>暂时无法进入聊天</h1>
      <p role="alert">{{ session.error.value }}</p>
      <button class="primary" @click="session.retry()">重新进入</button
      ><button @click="location.reload()">刷新网页</button
      ><button
        v-if="session.items.value.length"
        @click="session.accountsOpen.value = true"
      >
        切换其他账号</button
      ><button @click="session.cancelAdd">返回登录</button></template
    >
    <template v-else><p role="status">正在进入聊天…</p></template>
  </main>
</template>
