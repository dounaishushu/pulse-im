<script setup lang="ts">
import { inject, shallowRef } from "vue";
import platform from "virtual:pulse-platform";
import { accountsKey } from "../../composables/useSession";
import type { DesktopRelease } from "../../platform/contracts";
import DesktopUpdateDownload from "../desktop/DesktopUpdateDownload.vue";

const session = inject(accountsKey);
const updates = platform.updates!;
const automatic = shallowRef(localStorage.getItem("pulse_setting_auto_update") !== "0");
const busy = shallowRef(false);
const error = shallowRef("");
const result = shallowRef<DesktopRelease>();
function saveAutomatic() {
  localStorage.setItem("pulse_setting_auto_update", automatic.value ? "1" : "0");
  if (!automatic.value) session?.dismissUpdate();
}
async function check() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  result.value = undefined;
  try {
    const value = await updates.check(true);
    result.value = value;
    if (value.required) session?.observeDesktopRelease(value);
  } catch (cause) {
    error.value = typeof cause === "string" ? cause : "暂时无法检查更新，请稍后重试。";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="release-settings">
    <h3>版本和更新</h3>
    <div class="release-version"><span>当前版本 {{ platform.version }}</span>
      <button type="button" :disabled="busy" @click="check">{{ busy ? '正在检查…' : '检查更新' }}</button>
    </div>
    <label class="vue-toggle">
      <input v-model="automatic" type="checkbox" @change="saveAutomatic" />
      <span>自动检查更新</span>
    </label>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-else-if="result">
      <p role="status">{{ result.available ? `发现新版本 ${result.latestVersion}` : '当前已是最新版本' }}</p>
      <p v-if="result.available && result.notes" class="release-notes">{{ result.notes }}</p>
      <DesktopUpdateDownload v-if="result.available && result.downloadable" :release="result" />
    </template>
  </section>
</template>

<style scoped>
.release-settings { display: grid; gap: 8px; }
.release-settings :is(p, h3) { margin: 0; }
.release-version { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.release-notes { white-space: pre-wrap; }
</style>
