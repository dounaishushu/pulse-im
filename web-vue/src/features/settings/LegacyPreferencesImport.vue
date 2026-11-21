<script setup lang="ts">
import { onScopeDispose, shallowRef, useTemplateRef } from "vue";
import { useSettingsContext } from "./useSettings";
import type { DesktopDownloadPreferences, LegacyDownloadPreferences } from "../../platform/contracts";

const emit = defineEmits<{ downloadRestored: [preferences: DesktopDownloadPreferences] }>();
const { importLegacyPreferences, restoreLegacyDownload } = useSettingsContext();
const picker = useTemplateRef<HTMLInputElement>("picker");
const loading = shallowRef(false);
const status = shallowRef("");
const pendingDownload = shallowRef<LegacyDownloadPreferences>();
let alive = true;

async function upload(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || loading.value) return;
  loading.value = true;
  status.value = "";
  pendingDownload.value = undefined;
  try {
    const result = await importLegacyPreferences(file);
    if (!alive || !result) return;
    pendingDownload.value = result.download;
    if (result.count) status.value = `已导入 ${result.count} 项界面设置。`;
  } catch (cause) {
    if (alive) status.value = cause instanceof Error ? cause.message : "暂时无法导入设置。";
  } finally {
    loading.value = false;
  }
}

async function restoreDirectory() {
  if (!pendingDownload.value || loading.value) return;
  loading.value = true;
  try {
    const restored = await restoreLegacyDownload(pendingDownload.value);
    if (restored && alive) {
      emit("downloadRestored", restored);
      status.value = "已恢复下载设置。";
      pendingDownload.value = undefined;
    }
  } catch (cause) {
    if (alive) status.value = typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "暂时无法恢复下载设置。";
  } finally {
    loading.value = false;
  }
}

onScopeDispose(() => { alive = false; });
</script>

<template>
  <div class="settings-import">
    <input ref="picker" type="file" accept=".json,application/json" hidden @change="upload" />
    <button type="button" :disabled="loading" @click="picker?.click()">导入旧版界面设置</button>
    <template v-if="pendingDownload">
      <p v-if="pendingDownload.directory">旧版下载目录 {{ pendingDownload.directory }}</p>
      <button type="button" :disabled="loading" @click="restoreDirectory">确认旧版下载设置</button>
    </template>
    <p v-if="status" role="status">{{ status }}</p>
  </div>
</template>

<style scoped>
.settings-import { display: grid; justify-items: start; gap: 4px; }
.settings-import p { margin: 0; color: var(--ui-muted); overflow-wrap: anywhere; min-width: 0; }
</style>
