<script setup lang="ts">
import { useTemplateRef } from "vue";
import UiIcon from "../../components/UiIcon.vue";

defineProps<{ modifier: boolean }>();
const emit = defineEmits<{ change: [modifier: boolean] }>();
const menu = useTemplateRef<HTMLDetailsElement>("menu");
const trigger = useTemplateRef<HTMLElement>("trigger");
const options = [
  { modifier: false, label: "按 Enter 发送" },
  { modifier: true, label: "按 Ctrl / ⌘ + Enter 发送" },
];
function choose(value: boolean) {
  emit("change", value);
  close(true);
}
function close(restoreFocus = false) {
  if (!menu.value?.open) return;
  menu.value.open = false;
  if (restoreFocus) trigger.value?.focus();
}
function blur(event: FocusEvent) {
  if (!menu.value?.contains(event.relatedTarget as Node | null)) close();
}
</script>

<template>
  <details
    ref="menu"
    class="composer-send-mode"
    @focusout="blur"
    @keydown.esc.stop.prevent="close(true)"
  >
    <summary ref="trigger" aria-label="发送快捷键" title="发送快捷键">
      <UiIcon name="down" />
    </summary>
    <div class="composer-send-options" role="group" aria-label="选择发送快捷键">
      <button
        v-for="option in options"
        :key="String(option.modifier)"
        type="button"
        :aria-pressed="modifier === option.modifier"
        @click="choose(option.modifier)"
      >
        <span>{{ option.label }}</span>
        <UiIcon v-if="modifier === option.modifier" name="check" />
      </button>
      <small>Shift + Enter 换行</small>
    </div>
  </details>
</template>

<style scoped>
.composer-send-mode {
  position: relative;
}
.composer-send-mode summary {
  display: grid;
  place-items: center;
  inline-size: 30px;
  block-size: 34px;
  border-inline-start: 1px solid
    color-mix(in srgb, var(--ui-on-primary) 25%, transparent);
  border-radius: 0 6px 6px 0;
  background: var(--ui-primary);
  color: var(--ui-on-primary);
  font-size: 15px;
  list-style: none;
  cursor: pointer;
}
.composer-send-mode summary::-webkit-details-marker {
  display: none;
}
.composer-send-mode summary:hover,
.composer-send-mode[open] summary {
  background: var(--ui-primary-hover);
}
.composer-send-mode[open] summary .ui-icon {
  transform: rotate(180deg);
}
.composer-send-options {
  position: absolute;
  z-index: 8;
  inset: auto 0 calc(100% + 8px) auto;
  width: max-content;
  padding: 4px;
  border: 1px solid var(--ui-line);
  border-radius: 8px;
  background: var(--ui-surface);
  box-shadow: var(--ui-popover-shadow);
}
.composer-send-options button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  width: 100%;
  padding-inline: 9px;
  background: transparent;
  font-size: 12px;
  text-align: start;
}
.composer-send-options button[aria-pressed="true"] {
  color: var(--ui-primary);
}
.composer-send-options small {
  display: block;
  margin: 4px 5px 0;
  padding: 6px 4px 3px;
  border-top: 1px solid var(--ui-line);
  color: var(--ui-muted);
  font-size: 11px;
}
</style>
