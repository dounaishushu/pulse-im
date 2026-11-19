<script setup lang="ts">
import { computed, inject, shallowRef, useTemplateRef } from "vue";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import { chatKey } from "../../composables/useChat";
import { accountsKey } from "../../composables/useSession";
import { applyChatTheme } from "../../composables/chatTheme";
import { usePreferences } from "../../composables/usePreferences";
import type { Conversation } from "../../api/types";
import { WEB_VERSION } from "../../api/client";
import AccountSwitcher from "../accounts/AccountSwitcher.vue";

const chat = inject(chatKey)!;
const accounts = inject(accountsKey)!;
const { me, tab, panel, archived, totalUnread, notificationUnread } = chat;
const preferences = usePreferences();
const menu = shallowRef(false);
const menuButton = useTemplateRef<HTMLButtonElement>("menuButton");
const emit = defineEmits<{ list: [] }>();
const isNight = computed(() => {
  void preferences.revision.value;
  return document.body.dataset.theme === "night";
});
const navigation = [
  { name: "消息", icon: "chat", action: "messages" },
  { name: "联系人", icon: "profile", action: "contacts" },
  { name: "群聊", icon: "group", action: "groups" },
  { name: "通知", icon: "bell", action: "notifications" },
  { name: "我的收藏", label: "收藏", icon: "bookmark", action: "favorites" },
] as const;
const tools = [
  { name: "新建群组", icon: "group", action: "create-group" },
  { name: "新建频道", icon: "chat", action: "create-channel" },
  { name: "加入群聊 / 频道", icon: "link", action: "join" },
  { name: "我的二维码", icon: "qr", action: "qr" },
  { name: "通话记录", icon: "phone", action: "calls" },
  { name: "群发任务", icon: "send", action: "broadcast" },
] as const;
function closeMenu(restoreFocus = false) {
  menu.value = false;
  if (restoreFocus) menuButton.value?.focus();
}
function showPanel(next: typeof panel.value) {
  if (next === "contacts") {
    chat.contactId.value = undefined;
    chat.contactCard.value = null;
    chat.contactContext.value = undefined;
  }
  panel.value = next;
  closeMenu();
}
async function select(action: (typeof navigation)[number]["action"]) {
  closeMenu();
  if (action === "messages" || action === "groups") {
    tab.value = action;
    emit("list");
  } else if (action === "favorites") {
    try {
      const row = await chat.post<Conversation>("/conversations/favorites", {});
      await chat.choose(row.id);
    } catch (cause) {
      chat.error(cause);
    }
  } else showPanel(action);
}
function night() {
  const current = localStorage.getItem("pulse_chat_theme") || "classic";
  const next =
    current === "night"
      ? localStorage.getItem("pulse_chat_light_theme") || "classic"
      : "night";
  if (current !== "night")
    localStorage.setItem("pulse_chat_light_theme", current);
  localStorage.setItem("pulse_chat_theme", next);
  localStorage.setItem("pulse_night_mode", next === "night" ? "1" : "0");
  applyChatTheme(next);
  window.dispatchEvent(new Event("pulse:preferences"));
}
</script>

<template>
  <div class="workspace-identity vue-profile">
    <div class="workspace-account-cluster">
      <button
        class="vue-accounts-open workspace-account-button"
        type="button"
        aria-haspopup="dialog"
        :aria-label="
          me?.nickname ? `${me.nickname}，切换或添加账号` : '切换或添加账号'
        "
        title="切换或添加账号"
        @click="accounts.accountsOpen.value = true"
      >
        <AvatarImage :name="me?.nickname" :src="me?.avatar_url" />
        <span class="workspace-account-name truncate">{{
          me?.nickname || "账号"
        }}</span>
        <UiIcon name="down" class="workspace-account-caret" />
      </button>
      <span
        class="workspace-network"
        :class="{ online: chat.connected.value }"
        :title="chat.connected.value ? '已连接' : '正在恢复连接'"
        role="status"
      >
        <i aria-hidden="true"></i>{{ chat.connected.value ? "已连接" : "重连中" }}
      </span>
    </div>
    <h1 class="workspace-mobile-title">{{ archived ? "已归档" : "消息" }}</h1>
  </div>
  <nav class="workspace-rail flex flex-col" aria-label="主导航">
    <div class="workspace-rail-primary">
      <button
        v-for="entry in navigation"
        :key="entry.action"
        type="button"
        class="rail-button"
        :aria-label="entry.name"
        :title="entry.name"
        :aria-current="
          (entry.action === 'messages' &&
            tab !== 'groups' &&
            panel === 'none') ||
          (entry.action === 'groups' && tab === 'groups' && panel === 'none') ||
          (entry.action === 'favorites' &&
            chat.active.value?.type === 'favorites') ||
          (entry.action === 'contacts' && panel === 'add-contact') ||
          panel === entry.action
            ? 'page'
            : undefined
        "
        @click="select(entry.action)"
      >
        <UiIcon :name="entry.icon" />
        <span
          v-if="
            (entry.action === 'messages' && totalUnread) ||
            (entry.action === 'notifications' && notificationUnread)
          "
          class="unread rail-badge"
          aria-hidden="true"
        >
          {{
            Math.min(
              99,
              entry.action === "messages" ? totalUnread : notificationUnread,
            )
          }}
        </span>
        <span class="rail-label">{{
          "label" in entry ? entry.label : entry.name
        }}</span>
      </button>
    </div>
    <div class="workspace-rail-secondary">
      <button
        class="rail-button"
        type="button"
        aria-label="设置"
        title="设置"
        :aria-current="panel === 'settings' ? 'page' : undefined"
        @click="showPanel('settings')"
      >
        <UiIcon name="settings" />
        <span class="rail-label">设置</span>
      </button>
      <button
        ref="menuButton"
        class="rail-button"
        type="button"
        aria-label="打开菜单"
        title="打开菜单"
        :aria-expanded="menu"
        aria-controls="workspace-menu"
        @click="menu = !menu"
      >
        <UiIcon name="menu" />
        <span class="rail-label">菜单</span>
      </button>
    </div>
  </nav>
  <template v-if="menu">
    <div
      class="workspace-menu-shield"
      aria-hidden="true"
      @click="closeMenu()"
    ></div>
    <section
      id="workspace-menu"
      class="vue-side-menu workspace-menu"
      aria-label="功能菜单"
      @keydown.esc.stop="closeMenu(true)"
    >
      <AccountSwitcher @selected="closeMenu()" />
      <div class="workspace-menu-links">
        <template v-for="tool in tools" :key="tool.action">
          <button
            v-if="tool.action !== 'broadcast' || me?.internal_staff"
            type="button"
            @click="showPanel(tool.action)"
          >
            <UiIcon :name="tool.icon" /> {{ tool.name }}
          </button>
        </template>
        <button
          type="button"
          role="switch"
          :aria-checked="isNight"
          @click="night"
        >
          <UiIcon :name="isNight ? 'sun' : 'night'" /> 夜间模式<span
            class="ui-switch-visual"
            aria-hidden="true"
          ></span>
        </button>
        <button type="button" disabled title="当前服务没有翻译接口">
          <UiIcon name="language" /> 自动翻译（暂未开放）
        </button>
      </div>
      <footer class="workspace-menu-footer flex items-center justify-between">
        <small>版本 {{ WEB_VERSION }}</small>
        <button type="button" class="ui-text-button" @click="chat.logout">
          <UiIcon name="exit" /> 退出登录
        </button>
      </footer>
    </section>
  </template>
</template>

<style scoped>
.workspace-identity {
  grid-area: 1 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  border-inline-end: 1px solid var(--ui-line);
  background: var(--workspace-rail-surface, var(--ui-rail-bg));
}
.workspace-account-cluster {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.workspace-mobile-title {
  display: none;
}
.workspace-network {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  color: var(--ui-muted);
  font-size: 10px;
  white-space: nowrap;
}
.workspace-network i {
  inline-size: 6px;
  block-size: 6px;
  border-radius: 50%;
  background: var(--ui-warning);
}
.workspace-network.online i {
  background: #22a670;
}
.workspace-identity .workspace-account-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-inline-size: 0;
  min-block-size: 44px;
  padding: 4px;
  border-radius: 9px;
  background: transparent;
  font-weight: 600;
}
.workspace-account-button:not(:disabled):hover {
  background: var(--art-hover-color);
}
.workspace-account-button .avatar {
  --avatar-size: 36px;
  --avatar-radius: 8px;
}
.workspace-account-name,
.workspace-account-caret {
  display: none;
}
.workspace-rail {
  grid-area: 2 / 1;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
  padding: 11px 6px max(9px, env(safe-area-inset-bottom));
  border-inline-end: 1px solid var(--ui-line);
  background: var(--workspace-rail-surface, var(--ui-rail-bg));
  min-height: 0;
  overflow: auto;
  scrollbar-width: none;
}
.workspace-rail :is(.workspace-rail-primary, .workspace-rail-secondary) {
  display: grid;
  justify-items: center;
  gap: 7px;
}
.workspace-rail .rail-button {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  gap: 3px;
  padding: 0;
  inline-size: 54px;
  block-size: 54px;
  font-size: 25px;
  color: var(--ui-muted);
  background: transparent;
  border-radius: 8px;
}
.workspace-rail .rail-button[aria-current="page"],
.workspace-rail .rail-button[aria-expanded="true"] {
  color: var(--ui-primary);
  background: var(--art-active-color);
}
.rail-label {
  font-size: var(--ui-font-caption);
  line-height: 1.25;
  white-space: nowrap;
}
.rail-badge {
  position: absolute;
  top: 1px;
  inset-inline-end: 4px;
  min-width: 16px;
  height: 16px;
  font-size: 9px;
  padding-inline: 3px;
}
.workspace-menu {
  inset: auto auto 10px calc(var(--rail-width) + 6px);
}
.workspace-menu-links {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  padding-block: 5px;
}
.workspace-menu-links button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-inline: 7px;
  min-height: 35px;
  font-size: 12px;
}
.workspace-menu-links button:last-of-type {
  grid-column: 1 / -1;
}
.workspace-menu-footer {
  padding: 6px 5px 1px 8px;
  border-top: 1px solid var(--ui-line);
}
.workspace-menu-footer small {
  color: var(--ui-muted);
}
.workspace-menu-footer .ui-text-button {
  padding: 5px 7px;
  font-size: 12px;
  color: var(--ui-danger);
}

@media (max-width: 760px) {
  .workspace-identity {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: 8px;
    padding-inline: 12px;
    border: 0;
    background: var(--workspace-list-surface, var(--ui-sidebar));
  }
  .workspace-account-cluster {
    flex-direction: row;
    gap: 4px;
  }
  .workspace-mobile-title {
    display: block;
    font-size: var(--ui-font-heading);
    line-height: var(--ui-line-heading);
    font-weight: var(--ui-weight-strong);
    white-space: nowrap;
  }
  .workspace-identity .workspace-account-button {
    flex: 0 1 auto;
    gap: 4px;
  }
  .workspace-account-button .avatar {
    --avatar-size: 30px;
  }
  .workspace-account-button .workspace-account-caret {
    display: inline-flex;
  }
  .workspace-account-button .workspace-account-caret {
    flex: none;
    color: var(--ui-muted);
    font-size: 11px;
  }
  .workspace-network {
    font-size: 11px;
  }
  .workspace-rail {
    grid-area: 3 / 1;
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    place-items: center;
    gap: 0;
    padding: 4px 5px max(5px, env(safe-area-inset-bottom));
    border: 0;
    border-top: 1px solid var(--ui-line);
  }
  .workspace-rail :is(.workspace-rail-primary, .workspace-rail-secondary) {
    display: contents;
  }
  .workspace-rail .rail-button {
    inline-size: min(100%, 54px);
    block-size: 48px;
    font-size: 22px;
  }
  .rail-badge {
    inset-inline-end: 1px;
  }
  .workspace-menu {
    inset: auto 8px
      calc(var(--mobile-rail-height) + env(safe-area-inset-bottom) + 3px) auto;
  }
}
@media (375px <= width <= 760px) {
  .workspace-account-name {
    display: block;
    min-inline-size: 0;
    font-size: 12px;
  }
}
</style>
