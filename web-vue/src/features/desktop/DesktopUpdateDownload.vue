<script setup lang="ts">
import { shallowRef } from "vue";
import platform from "virtual:pulse-platform";
import type { DesktopRelease } from "../../platform/contracts";

const { release } = defineProps<{ release: DesktopRelease }>();
const busy = shallowRef(false);
const error = shallowRef("");
async function open() {
  if (!platform.updates || busy.value || !release.downloadable) return;
  busy.value = true;
  error.value = "";
  try {
    await platform.updates.openDownload(release.latestVersion);
  } catch (cause) {
    error.value = typeof cause === "string" ? cause : "暂时无法打开新版下载地址。";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="release-download">
    <button v-if="release.downloadable" type="button" class="retry" :disabled="busy" @click="open">打开下载页</button>
    <span v-if="error" role="alert">{{ error }}</span>
    <span v-else-if="release.required && !release.downloadable">下载地址暂未配置</span>
  </div>
</template>

<style scoped>
.release-download { display: grid; gap: 4px; }
.release-download span { color: var(--ui-muted); font-size: var(--ui-font-secondary); }
</style>
