<script setup lang="ts">
import {
  defineAsyncComponent,
  onMounted,
  onErrorCaptured,
  onScopeDispose,
} from "vue";
import icon from "../../web/app-icon.png";
import AuthView from "./features/auth/AuthView.vue";
import { useSession } from "./composables/useSession";
const session = useSession();
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
    :require-avatar="session.config.value?.register_require_avatar === true"
    @authenticated="session.authenticated"
  />
  <Workspace
    v-else-if="session.phase.value === 'workspace'"
    @login-required="session.loginRequired"
    @failed="session.failed"
  />
  <main v-else class="startup-state" aria-live="polite">
    <img :src="icon" alt="" width="48" height="48" />
    <template v-if="session.phase.value === 'error'"
      ><h1>暂时无法进入聊天</h1>
      <p role="alert">{{ session.error.value }}</p>
      <button class="primary" @click="session.enter()">重新进入</button
      ><button @click="location.reload()">刷新网页</button
      ><button @click="session.loginRequired">返回登录</button></template
    >
    <template v-else><p role="status">正在进入聊天…</p></template>
  </main>
</template>
