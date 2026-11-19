<script setup lang="ts">
import UiIcon from "../../components/UiIcon.vue";
import { useSettingsContext } from "./useSettings";

const { section, titles, busy, open } = useSettingsContext();
const items = [
  { id: "home", icon: "profile", label: "账号与界面" },
  { id: "profile", icon: "edit" },
  { id: "notifications", icon: "bell" },
  { id: "privacy", icon: "shield" },
  { id: "chat", icon: "chat" },
  { id: "media", icon: "phone" },
  { id: "advanced", icon: "settings" },
  { id: "language", icon: "language" },
  { id: "password", icon: "lock" },
  { id: "security", icon: "shield" },
  { id: "help", icon: "help" },
] as const;
const parents = {
  sessions: "advanced",
  blocked: "privacy",
  lock: "advanced",
} as const;
</script>

<template>
  <nav class="settings-navigation" aria-label="设置分类">
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      class="settings-nav-item"
      :class="{ 'settings-nav-home': item.id === 'home' }"
      :aria-current="
        (section in parents
          ? parents[section as keyof typeof parents]
          : section) === item.id
          ? 'page'
          : undefined
      "
      :disabled="busy"
      @click="open(item.id)"
    >
      <UiIcon :name="item.icon" />
      <span>{{ "label" in item ? item.label : titles[item.id] }}</span>
      <UiIcon name="chevron" class="settings-nav-arrow" />
    </button>
  </nav>
</template>

<style scoped>
.settings-navigation {
  min-height: 0;
  padding: 9px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-inline-end: 1px solid var(--ui-line);
  background: var(--ui-sidebar);
}
.settings-navigation .settings-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 37px;
  margin-bottom: 2px;
  padding-inline: 9px;
  color: var(--ui-muted);
  background: transparent;
  font-size: 13px;
  text-align: start;
}
.settings-nav-item > span:not(.ui-icon) {
  flex: 1;
  min-width: 0;
}
.settings-nav-item .ui-icon {
  font-size: 17px;
}
.settings-nav-item .settings-nav-arrow {
  font-size: 11px;
  opacity: 0.65;
}
.settings-navigation .settings-nav-item[aria-current="page"] {
  color: var(--ui-primary);
  background: var(--art-active-color);
  font-weight: 650;
}
@media (max-width: 600px) {
  .settings-navigation {
    grid-row: 2;
    padding: 7px 12px 12px;
    border: 0;
    border-top: 1px solid var(--ui-line);
  }
  .settings-navigation .settings-nav-home {
    display: none;
  }
  .settings-navigation .settings-nav-item {
    min-height: 41px;
  }
}
</style>
