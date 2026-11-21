<script setup lang="ts">
import { computed, onMounted, onScopeDispose, shallowRef } from "vue";
import platform from "virtual:pulse-platform";
import { applyChatTypography, chatFonts, chatTypographyStyle, defaultChatTypography } from "../../composables/chatTypography";
import type { ChatTypography, TypographyState } from "../../platform/contracts";

const native = platform.chatTypography!;
const draft = shallowRef({ ...defaultChatTypography });
const ready = shallowRef(false);
const busy = shallowRef(false);
const feedback = shallowRef("");
const problem = shallowRef("");
const previewStyle = computed(() => chatTypographyStyle(draft.value));
let revision = -1;
let active = true;
let stop: (() => void) | undefined;

function update(snapshot: TypographyState) {
  if (!active || snapshot.revision < revision) return;
  revision = snapshot.revision;
  draft.value = snapshot.value;
  ready.value = true;
}

async function load() {
  if (busy.value) return;
  problem.value = "";
  busy.value = true;
  try {
    if (!stop) {
      const unlisten = await native.subscribe(update);
      if (!active) { unlisten(); return; }
      stop = unlisten;
    }
    update(await native.read());
  } catch {
    if (active) problem.value = "无法读取本机聊天字体。";
  } finally {
    busy.value = false;
  }
}

async function run(action: () => Promise<TypographyState | null>, message: string) {
  if (!ready.value || busy.value) return;
  problem.value = "";
  feedback.value = "";
  busy.value = true;
  try {
    const result = await action();
    if (result && active) {
      update(result);
      applyChatTypography(draft.value);
      feedback.value = message;
    }
  } catch (cause) {
    if (active) problem.value = typeof cause === "string" ? cause : "无法保存聊天字体，请重试。";
  } finally {
    busy.value = false;
  }
}
function sizeAt(event: Event) {
  const control = event.target as HTMLInputElement;
  if (Number.isFinite(control.valueAsNumber)) {
    draft.value = { ...draft.value, size: Math.min(28, Math.max(12, Math.round(control.valueAsNumber))) };
  }
}
function save(patch: Partial<ChatTypography> = {}) {
  const value = { ...draft.value, ...patch };
  draft.value = value;
  return run(() => native.save(value), "已保存");
}
onMounted(load);
onScopeDispose(() => { active = false; stop?.(); });
</script>

<template>
  <fieldset class="chat-font-settings" :disabled="!ready || busy">
    <legend>聊天字体</legend>
    <label class="font-setting-row">字号
      <input name="chat-font-size" type="number" min="12" max="28" :value="draft.size" placeholder="14"
        @input="sizeAt" @change="save()" />
    </label>
    <input class="font-setting-range" type="range" min="12" max="28" step="1" :value="draft.size"
      aria-label="调整聊天字号" @input="sizeAt" @change="save()" />
    <label class="font-setting-row">字体
      <select aria-label="聊天字体" :value="draft.family" @change="save({ family: ($event.target as HTMLSelectElement).value as ChatTypography['family'] })">
        <option v-for="(font, family) in chatFonts" :key="family" :value="family">{{ font.label }}</option>
      </select>
    </label>
    <label class="vue-toggle"><input type="checkbox" :checked="draft.bold"
      @change="save({ bold: ($event.target as HTMLInputElement).checked })" /><span>聊天文字加粗</span></label>
    <div class="chat-font-preview" aria-label="聊天字体预览" :style="previewStyle">你好，消息已经收到。</div>
    <div class="font-setting-actions">
      <button type="button" @click="run(() => native.importLegacy(), '已导入旧版字体')">导入旧版字体</button>
      <button type="button" @click="save(defaultChatTypography)">恢复默认</button>
      <span v-if="feedback" class="font-setting-feedback" role="status">{{ feedback }}</span>
    </div>
    <p v-if="problem && ready" role="alert">{{ problem }}</p>
  </fieldset>
  <div v-if="problem && !ready" class="font-load-error" role="alert">{{ problem }} <button type="button" @click="load">重试</button></div>
</template>

<style scoped>
.chat-font-settings {
  display: grid;
  min-width: 0;
  gap: 9px;
  margin: 7px 0;
  padding: 11px 13px;
  border: 1px solid var(--ui-line);
  border-radius: 8px;
}
.chat-font-settings legend { padding-inline: 5px; font-size: var(--ui-font-control); font-weight: 600; }
.font-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.font-setting-row input { width: 70px; font-variant-numeric: tabular-nums; }
.font-setting-row select { min-width: 120px; }
.font-setting-range { width: 100%; accent-color: var(--ui-primary); }
.chat-font-preview {
  min-height: 40px;
  display: grid;
  align-items: center;
  padding: 10px 13px;
  border-radius: 7px;
  background: var(--ui-bubble);
  color: var(--ui-text);
}
.font-setting-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.font-setting-feedback { margin-inline-start: auto; color: var(--ui-muted); }
.font-load-error { color: var(--ui-danger); }
</style>
