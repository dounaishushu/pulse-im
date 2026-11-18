<script setup lang="ts">
import { provide } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
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
const emit = defineEmits<{ close: [] }>();
const settings = useSettings(emit);
provide(settingsKey, settings);
const { section, titles, busy, loading, loadError, feedback, stopMic, open } =
  settings;
</script>
<template>
  <BaseDialog :title="titles[section]" :busy="busy" @close="emit('close')"
    ><button
      v-if="section !== 'home'"
      type="button"
      @click="
        stopMic();
        open('home');
      "
    >
      返回设置
    </button>
    <p role="status">{{ feedback }}</p>
    <p v-if="loading" role="status">正在加载设置…</p>
    <p v-if="loadError" role="alert">
      {{ loadError }}<button @click="open(section)">重新加载设置</button>
    </p>
    <fieldset class="vue-settings-content" :disabled="loading || !!loadError">
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
  </BaseDialog>
</template>
