<script setup lang="ts">
import { onMounted, onScopeDispose, useTemplateRef, watch } from "vue";
import UiIcon from "./UiIcon.vue";
const props = defineProps<{
  title: string;
  busy?: boolean;
  size?: "compact" | "wide";
  layout?: "accounts" | "settings" | "contacts" | "contact-profile" | "notifications" | "invitation" | "group-management" | "group-create" | "broadcast" | "contact-card-picker";
  inline?: boolean;
}>();
const previousFocus =
  document.activeElement instanceof HTMLElement ? document.activeElement : null;
onScopeDispose(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
const emit = defineEmits<{ close: [] }>();
const panel = useTemplateRef<HTMLElement>("panel");
const body = useTemplateRef<HTMLElement>("body");
onMounted(() => {
  const target = panel.value?.querySelector<HTMLElement>("[data-dialog-autofocus]") || panel.value;
  target?.focus({ preventScroll: true });
});
watch(
  () => props.title,
  () => {
    if (body.value) body.value.scrollTop = 0;
    if (document.activeElement === document.body)
      panel.value?.focus({ preventScroll: true });
  },
  { flush: "post" },
);
function keys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    if (!props.busy) emit("close");
  }
  if (props.inline || event.key !== "Tab") return;
  const nodes = [
    ...(panel.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]',
    ) || []),
  ].filter((node) => node.getClientRects().length);
  if (!nodes.length) {
    event.preventDefault();
    return;
  }
  if (
    event.shiftKey &&
    (document.activeElement === nodes[0] ||
      document.activeElement === panel.value)
  ) {
    event.preventDefault();
    nodes.at(-1)?.focus();
  } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
    event.preventDefault();
    nodes[0]?.focus();
  }
}
</script>
<template>
  <Teleport to="body" :disabled="inline">
    <div
      class="vue-modal-backdrop"
      :data-layout="layout"
      :class="{ 'vue-inline-panel': inline }"
      @click.self="!inline && !busy && emit('close')"
    >
      <section
        ref="panel"
        class="vue-dialog"
        :data-size="size"
        :data-layout="layout"
        role="dialog"
        :aria-modal="inline ? undefined : 'true'"
        :aria-label="title"
        tabindex="-1"
        @keydown="keys"
      >
        <header class="vue-dialog-header">
          <h2>{{ title }}</h2>
          <div class="vue-dialog-header-actions">
            <slot name="header-actions" />
            <button
              type="button"
              class="vue-dialog-close ui-icon-button"
              aria-label="关闭"
              :disabled="busy"
              @click="emit('close')"
            >
              <UiIcon name="close" />
            </button>
          </div>
        </header>
        <div ref="body" class="vue-dialog-body"><slot /></div>
        <footer v-if="$slots.footer" class="vue-dialog-footer">
          <slot name="footer" />
        </footer>
      </section></div
  ></Teleport>
</template>

<style scoped>
.vue-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  place-items: center;
  padding: max(12px, env(safe-area-inset-top))
    max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom))
    max(12px, env(safe-area-inset-left));
  background: var(--ui-backdrop);
}
.vue-dialog {
  --panel-width: 560px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  width: min(var(--panel-width), 100%);
  max-height: 100%;
  overflow: hidden;
  border: 1px solid var(--ui-line);
  border-radius: 9px;
  background: var(--ui-surface);
  box-shadow: var(--ui-dialog-shadow);
  outline: none;
}
.vue-dialog[data-size="compact"] {
  --panel-width: 450px;
}
.vue-dialog[data-size="wide"] {
  --panel-width: 690px;
}
.vue-dialog[data-layout="contact-profile"] {
  --panel-width: 450px;
  max-height: min(700px, 100%);
}
.vue-dialog[data-layout="contact-profile"] .vue-dialog-body {
  padding: 14px 20px;
}
.vue-dialog[data-layout="contact-profile"] .vue-dialog-footer {
  padding: 12px;
  background: var(--ui-surface);
}
.vue-dialog[data-layout="invitation"] {
  --panel-width: 860px;
  height: min(650px, 100%);
}
.vue-dialog[data-layout="invitation"] .vue-dialog-header,
.vue-dialog[data-layout="invitation"] .vue-dialog-footer {
  background: var(--ui-surface);
  border: 0;
}
.vue-dialog[data-layout="invitation"] .vue-dialog-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  padding: 18px 24px 24px;
}
.vue-dialog[data-layout="group-management"] { --panel-width: 370px; }
.vue-dialog[data-layout="contact-card-picker"] { --panel-width: 440px; height: min(650px, 100%); }
.vue-dialog[data-layout="contact-card-picker"] .vue-dialog-header { background: var(--ui-surface); }
.vue-dialog[data-layout="contact-card-picker"] .vue-dialog-body { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; padding: 14px 16px 10px; }
.vue-dialog[data-layout="broadcast"] { --panel-width: 860px; height: min(610px, 100%); }
.vue-dialog[data-layout="broadcast"] .vue-dialog-header,
.vue-dialog[data-layout="broadcast"] .vue-dialog-footer { background: var(--ui-surface); padding: 12px 18px; }
.vue-dialog[data-layout="broadcast"] .vue-dialog-header { min-height: 52px; }
.vue-dialog[data-layout="broadcast"] .vue-dialog-body { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; padding: 0; }
.vue-dialog[data-layout="broadcast"] .vue-dialog-footer { border-top: 1px solid var(--ui-line); }
.vue-dialog[data-layout="group-create"] { --panel-width: 840px; height: min(560px, 100%); }
.vue-dialog[data-layout="group-create"] .vue-dialog-header,
.vue-dialog[data-layout="group-create"] .vue-dialog-footer { background: var(--ui-surface); border: 0; padding: 12px 16px; }
.vue-dialog[data-layout="group-create"] .vue-dialog-header h2 { font-weight: 500; }
.vue-dialog[data-layout="group-create"] .vue-dialog-body { display: flex; flex: 1; overflow: hidden; padding: 12px 18px 20px; }
.vue-dialog[data-layout="group-management"] .vue-dialog-body { padding: 0; }
.vue-dialog[data-layout="group-management"] .vue-dialog-header,
.vue-dialog[data-layout="group-management"] .vue-dialog-footer { background: var(--ui-surface); border: 0; padding: 12px 20px; }
.vue-dialog[data-layout="group-management"] .vue-dialog-footer { border-top: 1px solid var(--ui-line); }
.vue-dialog[data-layout="accounts"] {
  --panel-width: 474px;
}
.vue-dialog[data-layout="settings"] {
  --panel-width: 800px;
}
.vue-dialog-header,
.vue-dialog-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 9px var(--ui-space-dialog);
  background: var(--ui-surface-soft);
}
.vue-dialog-header {
  justify-content: space-between;
  border-bottom: 1px solid var(--ui-line);
}
.vue-dialog-header h2 {
  min-width: 0;
  font-size: var(--ui-font-content);
  line-height: var(--ui-line-heading);
  font-weight: var(--ui-weight-strong);
  overflow-wrap: anywhere;
}
.vue-dialog-header-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
}
.vue-dialog-header .vue-dialog-close {
  font-size: 17px;
  margin-inline-end: -5px;
}
.vue-dialog-footer {
  flex-wrap: wrap;
  justify-content: flex-end;
  border-top: 1px solid var(--ui-line);
  padding-block: 11px;
}
.vue-dialog-body {
  min-height: 0;
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding: 16px var(--ui-space-dialog) 20px;
  overflow-wrap: anywhere;
}
.vue-dialog[data-layout="settings"] .vue-dialog-body {
  padding: 0;
}
.vue-dialog[data-layout="contacts"] {
  --panel-width: 680px;
  height: min(552px, 100%);
}
.vue-dialog[data-layout="contacts"] .vue-dialog-header {
  background: var(--ui-surface);
}
.vue-dialog[data-layout="contacts"] .vue-dialog-body {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}
.vue-modal-backdrop[data-layout="notifications"] {
  place-items: stretch end;
  padding: 0;
}
.vue-dialog[data-layout="notifications"] {
  --panel-width: 448px;
  height: 100%;
  border-block: 0;
  border-inline-end: 0;
  border-radius: 0;
}
.vue-dialog[data-layout="notifications"] .vue-dialog-header {
  min-height: 60px;
  padding-top: max(9px, env(safe-area-inset-top));
  background: var(--ui-surface);
}
.vue-dialog[data-layout="notifications"] .vue-dialog-body {
  display: flex;
  flex: 1;
  padding: 0;
  overflow: hidden;
}
@media (max-width: 620px) {
  .vue-dialog[data-layout="notifications"] {
    --panel-width: 100%;
    border: 0;
  }
}
.vue-inline-panel {
  grid-area: 2 / 4;
  position: relative;
  inset: auto;
  z-index: auto;
  display: flex;
  align-items: stretch;
  padding: 0;
  min-width: 0;
  min-height: 0;
  border-inline-start: 1px solid var(--ui-line);
  background: var(--ui-surface);
}
.vue-inline-panel .vue-dialog {
  width: 100%;
  max-height: 100%;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.vue-inline-panel .vue-dialog-body {
  --ui-space-dialog: 14px;
  flex: 1;
}
.vue-inline-panel .vue-dialog-header {
  min-height: 62px;
  background: var(--ui-surface);
}

.vue-dialog-body :deep(:is(h3, h4)) {
  margin: 13px 0 7px;
  font-size: var(--ui-font-control);
  font-weight: var(--ui-weight-strong);
}
.vue-dialog-body :deep(legend) {
  padding-inline: 5px;
  color: var(--ui-muted);
}
.vue-dialog-body :deep(fieldset:not(.vue-settings-content)) {
  min-width: 0;
  padding: 10px;
  margin-block: 10px;
  border: 1px solid var(--ui-line);
  border-radius: 6px;
}
.vue-dialog-body :deep(label) {
  display: grid;
  gap: 5px;
  margin: 9px 0;
  font-size: var(--ui-font-control);
}
.vue-dialog-body
  :deep(label:has(:is(input[type="checkbox"], input[type="radio"]))) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}
.vue-dialog
  :deep(:is(input[type="checkbox"], input[type="radio"], input[type="range"])) {
  accent-color: var(--ui-primary);
}
.vue-dialog :deep(input:is([type="checkbox"], [type="radio"])) {
  flex: none;
  width: auto;
  height: auto;
}
.vue-dialog
  :deep(
    :is(
      input:not([type="checkbox"], [type="radio"], [type="range"]),
      select,
      textarea
    )
  ) {
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid var(--ui-line);
  border-radius: 6px;
  background: var(--ui-surface-soft);
  color: var(--ui-text);
}
.vue-dialog :deep(textarea) {
  min-height: 74px;
  resize: vertical;
}
.vue-dialog :deep(input[type="range"]) {
  width: 100%;
}
.vue-dialog :deep(input::file-selector-button) {
  margin-inline-end: 7px;
  padding: 4px 7px;
  border: 0;
  border-radius: 4px;
  background: var(--ui-fill);
  color: inherit;
  font: inherit;
}
.vue-dialog :deep(:is(input, select, textarea):focus-visible) {
  outline-offset: -2px;
}
.vue-dialog :deep(button:not(.ui-icon-button)) {
  min-height: 33px;
}
.vue-dialog :deep(.primary) {
  min-height: 36px;
}
.vue-dialog :deep(.vue-button-danger) {
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}
.vue-dialog :deep(.vue-button-danger:not(:disabled):hover) {
  background: var(--ui-danger-soft);
  box-shadow: inset 0 0 0 1px var(--ui-danger);
}
.vue-dialog :deep(.vue-fields) {
  display: grid;
  gap: 9px;
}
.vue-dialog :deep(.vue-fields > label) {
  margin: 0;
}
.vue-dialog :deep(.vue-fields > .primary) {
  justify-self: start;
}
.vue-dialog :deep(.vue-action-list) {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-block: 10px;
}
.vue-dialog :deep(.vue-panel-search) {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-block: 8px;
}
.vue-dialog :deep(.vue-panel-search button) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.vue-dialog-body :deep(.vue-panel-notice),
.vue-dialog-body :deep(p[role="alert"]:not(:empty)) {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-inline-start: 2px solid var(--ui-primary);
  background: var(--art-active-color);
}
.vue-dialog-body :deep(p[role="alert"]:not(:empty)) {
  border-color: var(--ui-danger);
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}
.vue-dialog :deep(.vue-contact-row) {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 0;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--ui-line);
}
.vue-dialog :deep(.vue-contact-row > span:not(.avatar)) {
  min-width: 0;
  flex: 1;
}
.vue-dialog :deep(.vue-contact-row small) {
  display: block;
  color: var(--ui-muted);
}
.vue-dialog :deep(button[role="switch"]) {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.vue-dialog :deep(.panel-section-title) {
  color: var(--ui-text);
}

@media (max-width: 600px) {
  .vue-modal-backdrop {
    --ui-space-dialog: 12px;
  }
  .vue-dialog-header,
  .vue-dialog-footer {
    padding-block: 7px;
  }
  .vue-dialog-header .vue-dialog-close {
    width: 40px;
    height: 40px;
  }
  .vue-dialog :deep(button:not(.ui-icon-button)) {
    min-height: 37px;
  }
}
</style>
