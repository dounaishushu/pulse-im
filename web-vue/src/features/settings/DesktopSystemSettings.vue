<script setup lang="ts">
import { onMounted, shallowRef } from "vue";
import platform from "virtual:pulse-platform";
import type { DesktopSystemOptions } from "../../platform/contracts";

const system = platform.system!;
const options = shallowRef<DesktopSystemOptions>();
const busy = shallowRef(false);
const error = shallowRef("");
const labels = {
  tray: "显示托盘图标",
  taskbar: "显示任务栏图标",
  autoLaunch: "开机自动启动",
  sendTo: "在 Windows「发送到」菜单中显示 Pulse IM",
} as const;

onMounted(async () => {
  try { options.value = await system.read(); }
  catch { error.value = "暂时无法读取 Windows 系统设置。"; }
});

async function change(key: keyof DesktopSystemOptions, event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (!options.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try { options.value = await system.set(key, input.checked); }
  catch (cause) {
    input.checked = options.value[key] === true;
    error.value = typeof cause === "string" ? cause : "无法保存 Windows 系统设置。";
  } finally { busy.value = false; }
}
</script>

<template>
  <section class="desktop-system-options">
    <h3>系统集成</h3>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="options">
      <label v-for="(label, key) in labels" :key="key" class="vue-toggle">
        <input
          type="checkbox"
          :checked="options[key] === true"
          :disabled="busy || options[key] === null"
          @change="change(key, $event)"
        />
        <span>{{ label }}<template v-if="options[key] === null">（状态暂不可读）</template></span>
      </label>
    </template>
  </section>
</template>

<style scoped>
.desktop-system-options {
  display: grid;
  gap: 5px;
  padding-block: 12px;
}
.desktop-system-options h3,
.desktop-system-options p {
  margin: 0;
}
</style>
