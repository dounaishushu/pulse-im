<script setup lang="ts">
import icon from "../../assets/pulse-mark.webp";
import UiIcon from "../../components/UiIcon.vue";
import type { DesktopRelease } from "../../platform/contracts";
import DesktopUpdateDownload from "../desktop/DesktopUpdateDownload.vue";
import DesktopProxySettings from "../desktop/DesktopProxySettings.vue";
import DesktopRouteSettings from "../desktop/DesktopRouteSettings.vue";
import platform from "virtual:pulse-platform";

defineProps<{
  state: "checking" | "error";
  error: string;
  desktop: boolean;
  canSwitchAccount: boolean;
  returnLabel?: string;
  requiredRelease?: DesktopRelease;
}>();

const emit = defineEmits<{
  retry: [];
  reload: [];
  switchAccount: [];
  returnToLogin: [];
}>();
</script>

<template>
  <main class="startup" aria-labelledby="startup-title">
    <section class="startup-panel">
      <header class="startup-header">
        <img :src="icon" alt="" width="36" height="36" />
        <h1 id="startup-title">
          {{ requiredRelease ? "需要更新客户端" : state === "error" ? "暂时无法进入聊天" : "正在进入聊天…" }}
        </h1>
      </header>
      <template v-if="state === 'error'">
        <p v-if="error" class="startup-detail" role="alert">{{ error }}</p>
        <template v-if="requiredRelease">
          <p class="startup-detail">当前 {{ requiredRelease.currentVersion }}，最低要求 {{ requiredRelease.minimumVersion }}</p>
          <div class="startup-actions">
            <DesktopUpdateDownload :release="requiredRelease" />
            <button type="button" class="reload" @click="emit('retry')">重新检查</button>
          </div>
        </template>
        <div v-else class="startup-actions">
          <button type="button" class="retry" @click="emit('retry')">
            重新进入
          </button>
          <button type="button" class="reload" @click="emit('reload')">
            <UiIcon name="refresh" />{{ desktop ? "重新加载" : "刷新页面" }}
          </button>
          <button
            v-if="canSwitchAccount"
            type="button"
            class="account-action"
            @click="emit('switchAccount')"
          >
            切换账号
          </button>
          <button type="button" class="account-action" @click="emit('returnToLogin')">
            {{ returnLabel || "返回登录" }}
          </button>
        </div>
        <div v-if="desktop && !requiredRelease && platform.windowKind === 'workspace'" class="startup-network">
          <DesktopRouteSettings v-if="platform.routes" />
          <DesktopProxySettings v-if="platform.network" />
        </div>
      </template>
      <span v-else class="startup-progress" aria-hidden="true"></span>
    </section>
  </main>
</template>

<style scoped>
.startup {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding: 24px clamp(8px, 4vw, 16px);
  background: var(--ui-canvas);
  color: var(--ui-text);
  font-family: var(--ui-font);
}
.startup-panel {
  width: min(100%, 424px);
  padding: clamp(12px, 4vw, 28px);
  container-type: inline-size;
  border-radius: 16px;
  background: var(--ui-surface);
  box-shadow:
    0 0 0 1px var(--ui-line),
    0 4px 20px rgb(25 34 48 / 5%);
}
.startup-header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.startup-header img {
  flex: none;
  border-radius: 9px;
}
.startup-header h1 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 650;
  line-height: var(--ui-line-heading);
}
.startup-detail {
  margin: 16px 0 0;
  color: var(--ui-muted);
  font-size: var(--ui-font-content);
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.startup-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 24px;
}
.startup button {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--ui-font-control);
  cursor: pointer;
  white-space: nowrap;
}
.startup button:focus-visible {
  outline: 2px solid var(--ui-focus);
  outline-offset: 2px;
}
.startup .retry {
  background: var(--ui-primary);
  color: var(--ui-on-primary);
  font-weight: 600;
}
.startup .retry:hover {
  background: var(--ui-primary-hover);
}
.startup .reload {
  border-color: var(--ui-line);
}
.startup .reload:hover,
.startup .account-action:hover {
  background: var(--art-hover-color);
}
.startup .reload .ui-icon {
  font-size: 0.9375rem;
}
.startup .account-action {
  padding-inline: 8px;
  color: var(--ui-muted);
}
.reload + .account-action {
  margin-inline-start: auto;
}
@container (max-width: 350px) {
  .startup-actions {
    gap: 4px;
  }
  .startup button {
    padding-inline: 6px;
  }
  .startup .account-action {
    padding-inline: 1px;
  }
  .startup .reload .ui-icon {
    display: none;
  }
}
.startup-network { margin-top: 12px; }
.startup-progress {
  display: block;
  height: 3px;
  margin-top: 20px;
  border-radius: 2px;
  background: var(--ui-line);
  overflow: hidden;
}
.startup-progress::after {
  display: block;
  width: 35%;
  height: 100%;
  border-radius: inherit;
  background: var(--ui-primary);
  content: "";
}
@media (prefers-reduced-motion: no-preference) {
  .startup-progress::after {
    animation: startup-progress 1.4s ease-in-out infinite alternate;
  }
  @keyframes startup-progress {
    to { transform: translateX(185%); }
  }
}
</style>
