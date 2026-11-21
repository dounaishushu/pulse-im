<script setup lang="ts">
import { CLIENT_PLATFORM } from "../../api/client";
import { useSettingsContext } from "./useSettings";
const {
  globalThis,
  Notification,
  feedback,
  notificationCount,
  saveNotificationCount,
  local,
  toggles,
  toggle,
} = useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <label
      v-for="[key, label] in toggles.notifications"
      :key="key"
      class="vue-toggle"
      ><input
        :checked="local[key]"
        type="checkbox"
        @change="toggle(key, ($event.target as HTMLInputElement).checked)"
      /><span>{{ label }}</span></label
    ><button
      v-if="CLIENT_PLATFORM === 'web'"
      @click="
        'Notification' in globalThis &&
        Notification.requestPermission().then(
          (value) => (feedback = '浏览器通知：' + value),
        )
      "
    >
      启用浏览器原生通知</button
    ><label
      >通知计数<select
        v-model.number="notificationCount"
        @change="saveNotificationCount"
      >
        <option v-for="value in [1, 2, 3, 4, 5]" :key="value" :value="value">
          {{ value }}
        </option>
      </select></label
    >
  </div>
</template>
