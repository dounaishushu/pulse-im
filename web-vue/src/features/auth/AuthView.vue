<script setup lang="ts">
import AuthStory from "./AuthStory.vue";
import CredentialsForm from "./CredentialsForm.vue";
import type { LoginResult } from "../../api/client";
import icon from "../../../../web/app-icon.png";
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
          ><span class="pc-auth-client">网页版 2.4.193</span>
        </div>
        <CredentialsForm
          :require-avatar="requireAvatar"
          :initial-account="initialAccount"
          :session-busy="sessionBusy"
          @authenticated="emit('authenticated', $event)"
        />
        <p class="pc-auth-bottom-note">小猿答疑 · 让沟通自然发生</p>
      </section>
    </div>
  </main>
</template>
