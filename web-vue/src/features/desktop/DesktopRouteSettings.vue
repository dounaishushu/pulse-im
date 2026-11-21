<script setup lang="ts">
import { onScopeDispose, shallowRef } from "vue";
import platform from "virtual:pulse-platform";
import type { DesktopRouteDirectory } from "../../platform/contracts";
import UiIcon from "../../components/UiIcon.vue";

const { compact = false } = defineProps<{ compact?: boolean }>();
const service = platform.routes!;
const expanded = shallowRef(false);
const directory = shallowRef<DesktopRouteDirectory>();
const busy = shallowRef(false);
const error = shallowRef("");
const status = shallowRef("");
let alive = true;

async function run(action: () => Promise<DesktopRouteDirectory>, message?: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  status.value = "";
  try {
    const next = await action();
    if (alive) {
      directory.value = next;
      status.value = message || "";
    }
  } catch (cause) {
    if (alive) error.value = typeof cause === "string" ? cause : "暂时无法读取线路，请重试。";
  } finally {
    busy.value = false;
  }
}
function toggle() {
  expanded.value = !expanded.value;
  if (expanded.value) void run(() => service.list(true));
}
function reloadCurrent() {
  if (expanded.value) void run(() => service.list());
}
window.addEventListener("pulse:desktop-route", reloadCurrent);
onScopeDispose(() => {
  alive = false;
  window.removeEventListener("pulse:desktop-route", reloadCurrent);
});
</script>

<template>
  <section class="route-settings" :data-compact="compact" aria-label="服务器线路">
    <button type="button" class="route-toggle" :aria-expanded="expanded" @click="toggle">
      <UiIcon name="settings" /> 服务器线路
      <UiIcon name="chevron" aria-hidden="true" />
    </button>
    <div v-if="expanded" class="route-panel">
      <div class="route-actions">
        <button type="button" :disabled="busy" @click="run(() => service.list(true))">刷新线路</button>
        <span v-if="busy" role="status">正在连接…</span>
      </div>
      <ul v-if="directory" class="route-list">
        <li v-for="route in directory.routes" :key="route.id">
          <div class="route-description">
            <strong>{{ route.name }}</strong>
            <span v-if="route.id === directory.currentId">当前线路</span>
            <span v-if="route.latencyMs !== null">{{ route.latencyMs }} ms</span>
          </div>
          <button type="button" :disabled="busy" :aria-label="`测速 ${route.name}`" @click="run(() => service.probe(route.id), '测速完成')">测速</button>
          <button v-if="route.id !== directory.currentId" type="button" :disabled="busy" :aria-label="`切换到 ${route.name}`" @click="run(() => service.select(route.id), '已切换线路')">切换</button>
        </li>
      </ul>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-else-if="status" role="status">{{ status }}</p>
    </div>
  </section>
</template>

<style scoped>
.route-settings { display: grid; justify-items: start; gap: 8px; margin-block: 6px; }
.route-settings[data-compact="true"] { margin-top: 12px; }
.route-toggle { display: inline-flex; align-items: center; gap: 7px; }
.route-panel { display: grid; width: 100%; gap: 8px; }
.route-panel p, .route-list { margin: 0; }
.route-list { list-style: none; padding: 0; display: grid; gap: 6px; }
.route-list li { display: flex; align-items: center; gap: 6px; border: 1px solid var(--ui-line); border-radius: 8px; padding: 8px; }
.route-list button { white-space: nowrap; }
.route-description { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; overflow-wrap: anywhere; }
.route-description span, .route-actions span { font-size: 12px; color: var(--ui-muted); }
.route-actions { display: flex; align-items: center; gap: 10px; }
</style>
