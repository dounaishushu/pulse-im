<script setup lang="ts">
import { watch } from "vue";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { useRoute, useRouter } from "vue-router";
import { useSession } from "./stores/session";
import { pages } from "./domain/catalog";
import AdminLayout from "./layout/AdminLayout.vue";
import LoginView from "./views/LoginView.vue";
const session = useSession();
const route = useRoute(),
  router = useRouter();
watch([session.account, route], () => {
  if (session.account.value && !session.can(String(route.name))) {
    const first = pages.find((p) => session.can(p.key));
    if (first) void router.replace({ name: first.key });
  }
});
</script>
<template>
  <el-config-provider :locale="zhCn">
    <div v-if="!session.ready.value" class="app-loading" role="status">
      <span class="loading-mark">P</span>
      <p>正在验证管理会话…</p>
    </div>
    <LoginView v-else-if="!session.account.value" />
    <AdminLayout v-else :key="session.generation.value" />
  </el-config-provider>
</template>
