<script setup lang="ts">
import {
  defineAsyncComponent,
  onMounted,
  onErrorCaptured,
  onScopeDispose,
  provide,
} from "vue";
import platform from "virtual:pulse-platform";
import { CLIENT_PLATFORM } from "./api/client";
import SessionStartup from "./features/auth/SessionStartup.vue";
import DesktopUpdateDownload from "./features/desktop/DesktopUpdateDownload.vue";
import AuthView from "./features/auth/AuthView.vue";
import type { ConversationWindowContext } from "./platform/contracts";
const props = defineProps<{ conversation?: ConversationWindowContext }>();
const ConversationWindow = defineAsyncComponent(() => import("./features/desktop/ConversationWindow.vue"));
import { useSession, accountsKey } from "./composables/useSession";
const session = props.conversation ? undefined : useSession();
if (session) provide(accountsKey, session);
const location = window.location;
const Workspace = defineAsyncComponent(
  () => import("./features/workspace/ChatWorkspace.vue"),
);
const AccountsDialog = defineAsyncComponent(
  () => import("./features/accounts/AccountsDialog.vue"),
);
function openAccountSettings() {
  if (!session) return;
  const current = session.current.value;
  if (!current || session.phase.value !== "workspace") return;
  session.accountsOpen.value = false;
  current.chat.panel.value = "settings";
}
const preloadFailed = (event: Event) => {
  event.preventDefault();
  session?.failed(Error(
    CLIENT_PLATFORM === "pc"
      ? "暂时无法加载客户端资源，请重新加载。"
      : "页面资源已更新，请刷新后加载新版。",
  ));
};
window.addEventListener("vite:preloadError", preloadFailed);
onScopeDispose(() =>
  window.removeEventListener("vite:preloadError", preloadFailed),
);
onMounted(() => {
  void session?.enter();
});
if (session && platform.windowKind === "workspace") {
  const shortcuts = new AbortController();
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.repeat || session.locked.value ||
      !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "n") return;
    event.preventDefault();
    void platform.workspaces?.open().catch(() => {});
  }, { signal: shortcuts.signal });
  onScopeDispose(() => shortcuts.abort());
}
onErrorCaptured((error) => {
  if (!session) return;
  session.failed(error);
  return false;
});
</script>

<template>
  <ConversationWindow v-if="conversation" :context="conversation" />
  <template v-else-if="session">
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
  />
  <AccountsDialog
    v-if="session.accountsOpen.value && !session.locked.value"
    :show-settings="
      session.phase.value === 'workspace' &&
      !!session.current.value &&
      session.current.value.chat.panel.value !== 'settings'
    "
    @settings="openAccountSettings"
  />
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
  <aside
    v-if="session.phase.value === 'workspace' && session.optionalUpdate.value && !session.locked.value"
    class="vue-account-notice"
    aria-label="客户端更新"
  >
    <span>有新版本 {{ session.optionalUpdate.value.latestVersion }}</span>
    <DesktopUpdateDownload :release="session.optionalUpdate.value" />
    <button type="button" @click="session.dismissUpdate()">稍后</button>
  </aside>
  <SessionStartup
    v-if="session.phase.value === 'checking' || session.phase.value === 'error'"
    :state="session.phase.value"
    :error="session.error.value"
    :required-release="session.desktopRelease.value?.required ? session.desktopRelease.value : undefined"
    :desktop="CLIENT_PLATFORM === 'pc'"
    :can-switch-account="session.items.value.length > 0"
    @retry="session.retry()"
    @reload="location.reload()"
    @switch-account="session.accountsOpen.value = true"
    @return-to-login="session.addAccount()"
  />
  </template>
</template>

<style lang="scss">
@use "@douyinfe/semi-theme-default/scss/global";
</style>

<style>
@layer theme, utilities, semi;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities) source(none);
@import "@douyinfe/semi-foundation/lib/es/button/button.css" layer(semi);
@source "./**/*.vue";

/* Art Design Pro's Tailwind semantic palette structure, adapted for Pulse IM.
   Copyright (c) 2025 SuperManTT. MIT; see THIRD_PARTY_NOTICES.md. */
:root {
  --art-gray-100: #f9fafb;
  --art-gray-200: #f2f4f5;
  --art-gray-300: #e6eaeb;
  --art-gray-600: #596674;
  --art-gray-900: #192230;
  --default-box-color: #fff;
  --default-border: #e3e7ed;
  --art-hover-color: #eef1f5;
  --art-active-color: #e7effc;
  --art-primary: #1768cf;
  --art-danger: #b83240;
  --art-success: #18724f;
  --ui-font:
    -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif;
  --ui-font-caption: 0.6875rem;
  --ui-font-secondary: 0.75rem;
  --ui-font-control: 0.8125rem;
  --ui-font-content: 0.875rem;
  --ui-font-heading: 1.0625rem;
  --ui-weight-strong: 600;
  --ui-line-heading: 1.35;
  --ui-line-content: 1.55;
  --ui-surface: var(--default-box-color);
  --ui-surface-soft: var(--art-gray-100);
  --ui-fill: #eef1f5;
  --ui-text: var(--art-gray-900);
  --ui-muted: var(--art-gray-600);
  --ui-line: var(--default-border);
  --ui-primary: var(--art-primary);
  --ui-primary-hover: #105bb9;
  --ui-primary-pressed: #124c97;
  --ui-on-primary: #fff;
  --ui-focus: #237ce8;
  --ui-danger: var(--art-danger);
  --ui-danger-soft: #fff0f1;
  --ui-success: var(--art-success);
  --ui-success-soft: #e8f5ee;
  --ui-warning: #8d561a;
  --ui-warning-soft: #fff6e4;
  --ui-canvas: #f9fafb;
  --ui-sidebar: #f5f6f8;
  --ui-rail-bg: #e9eef6;
  --ui-titlebar: #e5edf8;
  --ui-titlebar-end: #f3f6fa;
  --ui-selected-border: #a9c9f5;
  --ui-bubble: #edf0f4;
  --ui-outgoing: #1768cf;
  --ui-outgoing-text: #fff;
  --ui-backdrop: rgb(22 33 49 / 34%);
  --ui-popover-shadow:
    0 0 0 1px rgb(22 33 49 / 5%), 0 8px 28px rgb(22 33 49 / 14%);
  --ui-dialog-shadow:
    0 0 0 1px rgb(22 33 49 / 5%), 0 18px 60px rgb(22 33 49 / 20%);
  --ui-space-dialog: 20px;
  --avatar-surface-mix: 100%;
  --avatar-ink-mix: 100%;
}

body[data-theme="day"] {
  --ui-sidebar: #fff;
  --ui-canvas: #fcfdff;
  --ui-rail-bg: #eef5ff;
  --ui-titlebar: #edf5ff;
  --ui-outgoing: #dcecff;
  --ui-outgoing-text: #172b49;
}

body[data-theme="color"] {
  --ui-sidebar: #f3f8f7;
  --ui-canvas: #f7fbfa;
  --ui-rail-bg: #e0eeeb;
  --ui-titlebar: #dceeea;
  --ui-titlebar-end: #f5f8f7;
  --art-primary: #087c68;
  --ui-primary-hover: #066753;
  --ui-primary-pressed: #055547;
  --ui-focus: #16816e;
  --art-active-color: #e0f0eb;
  --ui-selected-border: #9bc9ba;
  --ui-outgoing: #087c68;
}

body[data-theme="night"] {
  --art-gray-100: #28292c;
  --art-gray-200: #2b2d32;
  --art-gray-300: #3c3e44;
  --art-gray-600: #abb0bb;
  --art-gray-900: #eff1f5;
  --default-box-color: #242529;
  --default-border: #3a3c43;
  --art-hover-color: #33353b;
  --art-active-color: #29394e;
  --art-primary: #82baff;
  --art-danger: #ff9ba3;
  --art-success: #81d7ad;
  --ui-primary-hover: #a9ceff;
  --ui-primary-pressed: #c2ddff;
  --ui-on-primary: #142537;
  --ui-focus: #82baff;
  --ui-danger-soft: #42292d;
  --ui-success-soft: #283c34;
  --ui-warning: #f0c48a;
  --ui-warning-soft: #473922;
  --ui-fill: #303237;
  --ui-canvas: #252629;
  --ui-sidebar: #212225;
  --ui-rail-bg: #262b34;
  --ui-titlebar: #2d3441;
  --ui-titlebar-end: #2b2e35;
  --ui-selected-border: #5276a0;
  --ui-bubble: #35373d;
  --ui-outgoing: #326cb3;
  --avatar-surface-mix: 18%;
  --avatar-ink-mix: 0%;
  --ui-backdrop: rgb(9 13 20 / 60%);
  --ui-popover-shadow: 0 0 0 1px rgb(0 0 0 / 18%), 0 8px 28px rgb(0 0 0 / 40%);
  --ui-dialog-shadow: 0 0 0 1px rgb(0 0 0 / 24%), 0 20px 60px rgb(0 0 0 / 50%);
}

:where(
  .vue-workspace,
  .vue-modal-backdrop,
  .vue-side-menu,
  .vue-lock-screen,
  .vue-account-notice
) {
  --ui-surface: var(--default-box-color);
  --ui-surface-soft: var(--art-gray-100);
  --ui-text: var(--art-gray-900);
  --ui-muted: var(--art-gray-600);
  --ui-line: var(--default-border);
  --ui-primary: var(--art-primary);
  --ui-danger: var(--art-danger);
  --ui-success: var(--art-success);
  --panel-surface: var(--ui-surface);
  --panel-text: var(--ui-text);
  --panel-muted: var(--ui-muted);
  --panel-line: var(--ui-line);
  --panel-soft: var(--ui-fill);
  --panel-field: var(--ui-surface-soft);
  --panel-accent: var(--ui-primary);
  --panel-on-accent: var(--ui-on-primary);
  --panel-current: var(--art-active-color);
  --panel-switch-off: #747e8d;
  --panel-danger: var(--ui-danger);
  --panel-danger-bg: var(--ui-danger-soft);
  --semi-color-primary: var(--ui-primary);
  --semi-color-primary-hover: var(--ui-primary-hover);
  --semi-color-primary-active: var(--ui-primary-pressed);
  --semi-color-text-0: var(--ui-text);
  --semi-color-text-2: var(--ui-muted);
  --semi-color-border: var(--ui-line);
  --semi-color-fill-0: var(--ui-fill);
  --semi-border-radius-small: 6px;
  font-family: var(--ui-font);
  color: var(--ui-text);
  font-size: var(--ui-font-control);
  line-height: 1.5;
}

@theme inline {
  --color-box: var(--ui-surface);
  --color-ink: var(--ui-text);
  --color-muted-ui: var(--ui-muted);
  --color-theme: var(--ui-primary);
  --color-hover-color: var(--art-hover-color);
  --color-active-color: var(--art-active-color);
  --color-line-ui: var(--ui-line);
}

:root {
  --auth-default-green: #16a179;
}
body {
  font-family: Inter, "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: auto;
}
.vue-account-return button,
#app > .vue-global-feedback button {
  border: 0;
  border-radius: 9px;
  padding: 12px 16px;
  font: inherit;
  cursor: pointer;
}
.vue-account-return {
  position: fixed;
  top: 16px;
  right: 20px;
  z-index: 105;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}
html,
body,
#app {
  min-height: 100%;
  margin: 0;
}
[hidden] {
  display: none !important;
}

:where(
  .vue-workspace,
  .vue-side-menu,
  .vue-dialog,
  .vue-lock-screen,
  .vue-account-notice
) {
  :is(button, input, select, textarea) {
    font: inherit;
  }
  button {
    border: 0;
    border-radius: 6px;
    padding: 7px 11px;
    color: inherit;
    background: var(--ui-fill);
    cursor: pointer;
  }
  button:not(:disabled):hover {
    background: var(--art-hover-color);
  }
  :disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  :focus-visible {
    outline: 2px solid var(--ui-focus);
    outline-offset: 2px;
  }
  :is(h1, h2, h3, h4, p, dl, dd, figure, blockquote) {
    margin: 0;
  }
  :is(img, video, canvas) {
    display: block;
    max-width: 100%;
  }
  :is(input, select, textarea)::placeholder {
    color: var(--ui-muted);
    opacity: 1;
  }
  a {
    color: var(--ui-primary);
  }
  .primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    background: var(--ui-primary);
    color: var(--ui-on-primary);
    font-weight: 600;
  }
  .primary:not(:disabled):hover {
    background: var(--ui-primary-hover);
  }
  .ui-text-button {
    background: transparent;
    color: var(--ui-primary);
  }
  .ui-text-button,
  .ui-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .ui-icon-button {
    width: 36px;
    height: 36px;
    flex: none;
    padding: 0;
    background: transparent;
    color: var(--ui-muted);
  }
  .ui-icon-button:not(:disabled):hover {
    color: var(--ui-text);
  }
  .ui-icon-button[aria-pressed="true"] {
    color: var(--ui-primary);
    background: var(--art-active-color);
  }
  .ui-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    line-height: 1;
  }
  .ui-icon svg {
    width: 1em;
    height: 1em;
  }
  .empty,
  .muted {
    color: var(--ui-muted);
  }
}

.unread {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 12px;
  color: #fff;
  background: #c83d50;
  font-size: var(--ui-font-caption);
  font-weight: var(--ui-weight-strong);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}
.unread.is-muted {
  background: #747e8d;
}

.vue-global-feedback,
.vue-account-notice {
  position: fixed;
  inset: auto auto max(16px, env(safe-area-inset-bottom)) 50%;
  z-index: 150;
  transform: translateX(-50%);
  max-width: min(620px, calc(100% - 24px));
  padding: 10px 14px;
  margin: 0;
  border: 1px solid var(--ui-line);
  border-radius: 8px;
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
  box-shadow: var(--ui-popover-shadow);
  font-size: var(--ui-font-control);
  overflow-wrap: anywhere;
}
.vue-account-notice {
  inset-block: 12px auto;
}
.vue-global-feedback button,
.vue-account-notice button {
  font-size: inherit;
  padding: 4px 7px;
  margin-inline-start: 7px;
}

@media (prefers-reduced-motion: reduce) {
  :is(.vue-workspace, .vue-modal-backdrop, .vue-side-menu),
  :is(.vue-workspace, .vue-modal-backdrop, .vue-side-menu) * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
body.vue-motion-disabled *,
body.vue-motion-disabled *::before,
body.vue-motion-disabled *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
}

.vue-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  margin-top: 12px;
  padding: 3px;
  border-radius: 7px;
  background: var(--ui-fill);
}
.vue-tabs button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  min-height: 31px;
  padding: 3px 2px;
  background: transparent;
  font-size: var(--ui-font-control);
  color: var(--ui-muted);
  white-space: nowrap;
}
.vue-tabs button[aria-current="page"] {
  background: var(--ui-surface);
  color: var(--ui-primary);
  font-weight: var(--ui-weight-strong);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}
.vue-tabs .unread {
  font-size: 10px;
  min-width: 15px;
  height: 15px;
  padding-inline: 4px;
}
.workspace-menu-shield {
  position: fixed;
  inset: 0;
  z-index: 29;
}
.vue-side-menu {
  position: fixed;
  display: flex;
  flex-direction: column;
  z-index: 30;
  width: min(300px, calc(100vw - 16px));
  max-height: min(660px, calc(100dvh - 28px));
  overflow: auto;
  overscroll-behavior: contain;
  padding: 7px;
  border: 1px solid var(--ui-line);
  border-radius: 8px;
  background: var(--ui-surface);
  box-shadow: var(--ui-popover-shadow);
}
.vue-side-menu button {
  text-align: start;
  background: transparent;
}
.ui-switch-visual {
  position: relative;
  flex: 0 0 29px;
  width: 29px;
  height: 16px;
  margin-inline-start: auto;
  border-radius: 10px;
  background: var(--panel-switch-off);
}
.ui-switch-visual::before {
  content: "";
  position: absolute;
  inset: 2px auto auto 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
}
[role="switch"][aria-checked="true"] .ui-switch-visual {
  background: var(--ui-primary);
}
[role="switch"][aria-checked="true"] .ui-switch-visual::before {
  left: 15px;
}
.vue-dialog .vue-details {
  display: grid;
  grid-template-columns: minmax(60px, 100px) minmax(0, 1fr);
  gap: 8px;
  margin-block: 8px;
  font-size: 13px;
}
.vue-dialog .vue-details dt {
  color: var(--ui-muted);
}
</style>
