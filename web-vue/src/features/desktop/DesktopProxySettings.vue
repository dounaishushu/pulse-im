<script setup lang="ts">
import { computed, onScopeDispose, shallowRef } from "vue";
import platform from "virtual:pulse-platform";
import type { DesktopNetworkOptions, DesktopNetworkPreferences } from "../../platform/contracts";
import UiIcon from "../../components/UiIcon.vue";

const { disabled = false } = defineProps<{ disabled?: boolean }>();
const service = platform.network!;
const open = shallowRef(false);
const loading = shallowRef(false);
const saving = shallowRef(false);
const probing = shallowRef<string>();
const preferences = shallowRef<DesktopNetworkOptions>();
const presetName = shallowRef("");
const error = shallowRef("");
const feedback = shallowRef("");
let disposed = false;

const modes = [
  { value: "direct", label: "直连" },
  { value: "system", label: "使用系统设置" },
  { value: "custom", label: "自定义代理" },
] as const;
const blocked = computed(() => disabled || loading.value || saving.value || !!probing.value);
const activePreset = computed(() => preferences.value?.saved.find((row) => row.id === preferences.value?.activeProxyId));

function edit(change: Partial<DesktopNetworkPreferences>) {
  if (preferences.value) preferences.value = { ...preferences.value, ...change };
  error.value = "";
  feedback.value = "";
}
function failure(cause: unknown, fallback: string) {
  if (!disposed) error.value = typeof cause === "string" ? cause : fallback;
}
async function load() {
  if (blocked.value || disposed) return;
  loading.value = true;
  error.value = feedback.value = "";
  try {
    const current = await service.read();
    if (disposed) return;
    preferences.value = current;
    presetName.value = "";
    if (current.readError) error.value = "已加载默认设置，原代理配置无法读取。";
  } catch (cause) {
    failure(cause, "暂时无法读取代理设置。");
  } finally {
    loading.value = false;
  }
}
function toggle() {
  if (blocked.value) return;
  open.value = !open.value;
  if (open.value) void load();
  else {
    preferences.value = undefined;
    presetName.value = error.value = feedback.value = "";
  }
}
function choosePreset(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  const preset = preferences.value?.saved.find((row) => row.id === id);
  if (!preset) {
    edit({ activeProxyId: null, proxyUrl: "" });
    presetName.value = "";
    return;
  }
  edit({ mode: "custom", activeProxyId: id, proxyUrl: preset.url });
  presetName.value = preset.name;
}
function savePreset() {
  const state = preferences.value;
  const name = presetName.value.trim();
  const url = state?.proxyUrl.trim();
  if (!state || !name || !url) return;
  if (!activePreset.value && state.saved.length >= 32) {
    error.value = "最多可保存 32 个代理预设。";
    return;
  }
  const id = activePreset.value?.id ?? crypto.randomUUID();
  const saved = activePreset.value
    ? state.saved.map((row) => row.id === id ? { id, name, url } : row)
    : [...state.saved, { id, name, url }];
  edit({ activeProxyId: id, saved, proxyUrl: url });
  feedback.value = "已编辑预设，应用后保存。";
}
function removePreset() {
  const state = preferences.value;
  if (!state || !state.activeProxyId) return;
  edit({ saved: state.saved.filter((row) => row.id !== state.activeProxyId), activeProxyId: null });
  presetName.value = "";
  feedback.value = "已移除预设，应用后保存。";
}
function snapshot(state: DesktopNetworkOptions): DesktopNetworkPreferences {
  return {
    mode: state.mode,
    proxyUrl: state.proxyUrl.trim(),
    useIpv6: state.useIpv6,
    saved: state.saved,
    activeProxyId: state.activeProxyId,
  };
}
async function apply() {
  const state = preferences.value;
  if (!state || blocked.value) return;
  saving.value = true;
  error.value = feedback.value = "";
  try {
    const updated = await service.save(snapshot(state), state.revision);
    if (disposed) return;
    preferences.value = updated;
    feedback.value = "已应用代理设置。";
  } catch (cause) {
    failure(cause, "暂时无法应用代理设置。");
  } finally {
    saving.value = false;
  }
}
async function test() {
  const state = preferences.value;
  if (!state || blocked.value) return;
  const id = crypto.randomUUID();
  probing.value = id;
  error.value = feedback.value = "";
  try {
    const latency = await service.test(snapshot(state), id);
    if (!disposed && probing.value === id) feedback.value = `连接成功 · ${latency} ms`;
  } catch (cause) {
    if (probing.value === id) failure(cause, "连接测试失败。");
  } finally {
    if (probing.value === id) probing.value = undefined;
  }
}
function cancel() {
  const id = probing.value;
  if (!id) return;
  probing.value = undefined;
  feedback.value = "已取消连接测试。";
  void service.cancelTest(id).catch(() => {});
}
onScopeDispose(() => {
  disposed = true;
  if (probing.value) void service.cancelTest(probing.value).catch(() => {});
  preferences.value = undefined;
});
</script>

<template>
  <section class="desktop-proxy" aria-label="代理设置">
    <button type="button" class="proxy-toggle" :aria-expanded="open" :disabled="blocked" @click="toggle">
      <UiIcon name="settings" /> 代理设置 <UiIcon name="chevron" aria-hidden="true" />
    </button>
    <div v-if="open" class="proxy-panel">
      <p v-if="loading" role="status">正在读取代理设置…</p>
      <form v-if="preferences" class="proxy-form" @submit.prevent="apply">
        <fieldset :disabled="blocked">
          <label>连接方式
            <select :value="preferences.mode" @change="edit({ mode: ($event.target as HTMLSelectElement).value as DesktopNetworkPreferences['mode'] })">
              <option v-for="mode in modes" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
            </select>
          </label>
          <template v-if="preferences.mode === 'custom'">
            <label v-if="preferences.saved.length">已保存的代理
              <select :value="preferences.activeProxyId ?? ''" @change="choosePreset">
                <option value="">手动输入</option>
                <option v-for="proxy in preferences.saved" :key="proxy.id" :value="proxy.id">{{ proxy.name }}</option>
              </select>
            </label>
            <label>代理地址
              <input type="password" :value="preferences.proxyUrl" autocomplete="off" spellcheck="false"
                placeholder="socks5://127.0.0.1:1080" maxlength="2048" required
                @input="edit({ proxyUrl: ($event.target as HTMLInputElement).value })" />
            </label>
            <label>预设名称<input v-model.trim="presetName" type="text" maxlength="80" /></label>
            <div class="proxy-actions">
              <button type="button" :disabled="!presetName || !preferences.proxyUrl" @click="savePreset">{{ activePreset ? "更新预设" : "添加预设" }}</button>
              <button v-if="activePreset" type="button" @click="removePreset">移除预设</button>
            </div>
          </template>
          <label class="proxy-ip"><input type="checkbox" :checked="preferences.useIpv6" @change="edit({ useIpv6: ($event.target as HTMLInputElement).checked })" /> 优先使用 IPv6</label>
        </fieldset>
        <div class="proxy-actions">
          <button v-if="probing" type="button" @click="cancel">取消测试</button>
          <button v-else type="button" :disabled="blocked" @click="test">测试连接</button>
          <button type="submit" class="primary" :disabled="blocked">{{ saving ? "正在应用…" : "应用" }}</button>
        </div>
      </form>
      <button v-if="error" type="button" :disabled="blocked" @click="load">重新读取配置</button>
      <p v-if="error" class="proxy-error" role="alert">{{ error }}</p>
      <p v-else-if="probing || feedback" role="status">{{ probing ? "正在测试连接…" : feedback }}</p>
    </div>
  </section>
</template>

<style scoped>
.desktop-proxy, .proxy-panel, .proxy-form, fieldset { display: grid; gap: 8px; }
.desktop-proxy { justify-items: start; margin-block: 6px; }
.proxy-toggle, .proxy-actions, .proxy-form .proxy-ip { display: flex; align-items: center; gap: 8px; }
.proxy-panel { width: 100%; max-width: 480px; padding: 12px; border: 1px solid var(--ui-line, #dce6e3); border-radius: 8px; }
fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
.proxy-form label { display: grid; gap: 4px; font-size: var(--ui-font-control, 13px); }
.proxy-form :is(input:not([type="checkbox"]), select) { width: 100%; min-width: 0; padding: 7px 9px; color: inherit; background: var(--ui-fill, #f4f7f6); border: 1px solid var(--ui-line, #dce6e3); border-radius: 6px; }
.proxy-panel p { margin: 0; font-size: var(--ui-font-secondary, 12px); }
.proxy-error { color: var(--ui-danger, #b53b4b); }
.proxy-actions { flex-wrap: wrap; }
</style>
