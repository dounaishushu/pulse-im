<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
const { localStorage, language } = useSettingsContext();
</script>
<template>
  <label
    >语言<select
      v-model="language"
      @change="localStorage.setItem('pulse_language', language)"
    >
      <option
        v-for="[id, label] in [
          ['zh-CN', '简体中文'],
          ['zh-TW', '繁體中文'],
          ['en', 'English'],
          ['ko', '한국어'],
          ['id', 'Indonesia'],
          ['th', 'ภาษาไทย'],
          ['fr', 'Français'],
          ['de', 'Deutsch'],
        ]"
        :key="id"
        :value="id"
      >
        {{ label }}
      </option></select
    ><small>保留原客户端的语言偏好；当前业务界面仍使用简体中文。</small></label
  >
</template>
