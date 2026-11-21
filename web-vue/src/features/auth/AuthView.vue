<script setup lang="ts">
import platform from "virtual:pulse-platform";
import AuthStory from "./AuthStory.vue";
import DesktopRouteSettings from "../desktop/DesktopRouteSettings.vue";
import DesktopProxySettings from "../desktop/DesktopProxySettings.vue";
import CredentialsForm from "./CredentialsForm.vue";
import { CLIENT_PLATFORM, CLIENT_VERSION, type LoginResult } from "../../api/client";
import icon from "../../assets/pulse-mark.webp";
defineProps<{
  requireAvatar: boolean;
  initialAccount?: string;
  sessionBusy?: boolean;
  adding?: boolean;
}>();
const emit = defineEmits<{ authenticated: [result: LoginResult] }>();
</script>
<template>
  <main class="login-shell pc-auth-shell">
    <div class="pc-auth-frame">
      <AuthStory />
      <section class="login-card pc-auth-card" aria-label="登录或注册">
        <div class="pc-auth-card-top">
          <span class="pc-auth-compact-brand"
            ><img
              :src="icon"
              alt=""
              class="pc-auth-brand-image"
            />小猿答疑</span
          ><span class="pc-auth-client">{{ CLIENT_PLATFORM === "pc" ? "桌面版" : "网页版" }} {{ CLIENT_VERSION }}</span>
        </div>
        <CredentialsForm
          :require-avatar="requireAvatar"
          :initial-account="initialAccount"
          :session-busy="sessionBusy"
          @authenticated="emit('authenticated', $event)"
        />
        <DesktopRouteSettings v-if="platform.routes" compact />
        <DesktopProxySettings v-if="platform.network" :disabled="sessionBusy" />
        <p class="pc-auth-bottom-note">小猿答疑 · 让沟通自然发生</p>
      </section>
    </div>
  </main>
</template>

<style>
@import "../../../../web/auth.css";

@layer legacy-login-base {
  .pc-auth-card input {
    font: inherit;
    outline: none;
  }
  .pc-auth-card button {
    border: 0;
    border-radius: 9px;
    padding: 12px 16px;
    font: inherit;
    cursor: pointer;
  }
}
.pc-auth-card .pc-auth-tabs button[aria-selected="true"] {
  color: var(--auth-accent);
  border-bottom: 2px solid var(--auth-accent);
}
</style>
