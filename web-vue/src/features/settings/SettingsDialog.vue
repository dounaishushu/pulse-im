<script setup lang="ts">
import { provide } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import UiIcon from "../../components/UiIcon.vue";
import { useSettings, settingsKey } from "./useSettings";
import HomeSettings from "./HomeSettings.vue";
import ProfileSettings from "./ProfileSettings.vue";
import NotificationsSettings from "./NotificationsSettings.vue";
import PrivacySettings from "./PrivacySettings.vue";
import ChatSettings from "./ChatSettings.vue";
import SessionsSettings from "./SessionsSettings.vue";
import BlockedSettings from "./BlockedSettings.vue";
import PasswordSettings from "./PasswordSettings.vue";
import SecuritySettings from "./SecuritySettings.vue";
import LockSettings from "./LockSettings.vue";
import AdvancedSettings from "./AdvancedSettings.vue";
import MediaSettings from "./MediaSettings.vue";
import LanguageSettings from "./LanguageSettings.vue";
import HelpSettings from "./HelpSettings.vue";
import SettingsNavigation from "./SettingsNavigation.vue";
const emit = defineEmits<{ close: [] }>();
const settings = useSettings(emit);
provide(settingsKey, settings);
const { section, titles, busy, loading, loadError, feedback, open } = settings;
</script>
<template>
  <BaseDialog
    :title="titles[section]"
    layout="settings"
    size="wide"
    :busy="busy"
    @close="emit('close')"
  >
    <div class="settings-layout" :data-section="section">
      <SettingsNavigation />
      <section
        class="settings-main"
        :aria-label="section === 'home' ? '账号与界面' : titles[section]"
      >
        <button
          v-if="section !== 'home'"
          type="button"
          class="vue-settings-back ui-text-button"
          :disabled="busy"
          @click="open('home')"
        >
          <UiIcon name="back" /> 返回设置
        </button>
        <h3 v-else class="panel-section-title">账号与界面</h3>
        <p v-if="feedback" class="vue-panel-notice" role="status">
          {{ feedback }}
        </p>
        <p v-if="loading" class="settings-loading" role="status">
          正在加载设置…
        </p>
        <p v-if="loadError" role="alert">
          {{ loadError }}<button @click="open(section)">重新加载设置</button>
        </p>
        <fieldset
          class="vue-settings-content"
          :disabled="loading || !!loadError"
        >
          <HomeSettings v-if="section === 'home'" />
          <ProfileSettings v-else-if="section === 'profile'" />
          <NotificationsSettings v-else-if="section === 'notifications'" />
          <PrivacySettings v-else-if="section === 'privacy'" />
          <ChatSettings v-else-if="section === 'chat'" />
          <SessionsSettings v-else-if="section === 'sessions'" />
          <BlockedSettings v-else-if="section === 'blocked'" />
          <PasswordSettings v-else-if="section === 'password'" />
          <SecuritySettings v-else-if="section === 'security'" />
          <LockSettings v-else-if="section === 'lock'" />
          <AdvancedSettings v-else-if="section === 'advanced'" />
          <MediaSettings v-else-if="section === 'media'" />
          <LanguageSettings v-else-if="section === 'language'" />
          <HelpSettings v-else-if="section === 'help'" />
        </fieldset>
      </section>
    </div>
  </BaseDialog>
</template>

<style scoped>
.settings-layout {
  display: grid;
  grid-template-columns: 188px minmax(0, 1fr);
  height: min(520px, calc(100dvh - 90px));
}
.settings-main {
  min-width: 0;
  min-height: 0;
  padding: 16px 19px 21px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.settings-main .vue-settings-back {
  margin-bottom: 8px;
  padding-inline: 0 8px;
}
.settings-main .panel-section-title {
  margin: 0 0 12px;
  font-size: var(--ui-font-content);
}
.settings-loading {
  color: var(--ui-muted);
  margin-block: 8px;
}
.vue-settings-content {
  margin: 0;
  padding: 0;
  min-width: 0;
  border: 0;
}
.vue-settings-content :deep(.vue-settings-section) {
  min-width: 0;
}
.vue-settings-content :deep(.vue-toggle) {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding-block: 8px;
  min-height: 45px;
  border-bottom: 1px solid var(--ui-line);
}
.vue-settings-content :deep(.vue-toggle input[type="checkbox"]) {
  appearance: none;
  position: relative;
  order: 1;
  flex: none;
  width: 36px;
  height: 20px;
  padding: 0;
  margin: 0 0 0 auto;
  border-radius: 12px;
  background: var(--panel-switch-off);
  cursor: pointer;
}
.vue-settings-content :deep(.vue-toggle input[type="checkbox"]::before) {
  position: absolute;
  content: "";
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
}
.vue-settings-content :deep(.vue-toggle input[type="checkbox"]:checked) {
  background: var(--ui-primary);
}
.vue-settings-content
  :deep(.vue-toggle input[type="checkbox"]:checked::before) {
  left: 19px;
}
@media (max-width: 600px) {
  .settings-layout {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
  .settings-main {
    padding: 12px;
    overflow: visible;
  }
  .settings-layout:not([data-section="home"]) > .settings-navigation {
    display: none;
  }
}
@media (forced-colors: active) {
  .vue-settings-content :deep(.vue-toggle input[type="checkbox"]) {
    appearance: auto;
  }
  .vue-settings-content :deep(.vue-toggle input[type="checkbox"]::before) {
    display: none;
  }
}
</style>
