<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
const { theme, local, toggles, toggle, setTheme, background } =
  useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <label
      >主题<select v-model="theme" @change="setTheme">
        <option value="classic">经典</option>
        <option value="day">白天</option>
        <option value="color">有色</option>
        <option value="night">夜间</option>
      </select></label
    ><label
      >聊天背景<input
        type="file"
        accept="image/*"
        @change="background" /></label
    ><label v-for="[key, label] in toggles.chat" :key="key" class="vue-toggle"
      ><input
        :checked="local[key]"
        type="checkbox"
        @change="toggle(key, ($event.target as HTMLInputElement).checked)"
      /><span>{{ label }}</span></label
    >
    <p>贴纸与 GIF 素材库当前为空，保留原有本机图片和 GIF 发送方式。</p>
  </div>
</template>
