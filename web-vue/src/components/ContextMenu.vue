<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, useTemplateRef } from "vue";

const props = defineProps<{ point?: { x: number; y: number }; label: string }>();
const emit = defineEmits<{ close: [] }>();
const menu = useTemplateRef<HTMLElement>("menu");
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
let disposed = false;
function place() {
  const element = menu.value;
  if (!element) return;
  // Mouse coordinates include interface zoom; fixed CSS coordinates do not.
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const width = window.innerWidth / zoom;
  const height = window.innerHeight / zoom;
  const x = (props.point?.x ?? window.innerWidth / 2) / zoom;
  const y = (props.point?.y ?? window.innerHeight / 2) / zoom;
  element.style.left = `${Math.max(6, Math.min(x, width - element.offsetWidth - 6))}px`;
  element.style.top = `${Math.max(6, Math.min(y, height - element.offsetHeight - 6))}px`;
}
function close() { if (!disposed) emit("close"); }
function toggled(event: Event) {
  if ((event as ToggleEvent).newState === "closed") close();
}
function keys(event: KeyboardEvent) {
  if (["Escape", "Tab"].includes(event.key)) {
    if (event.key === "Escape") event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') || [])];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
    (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
  buttons[next]?.focus();
}
function externalScroll(event: Event) {
  if (!(event.target instanceof Node) || !menu.value?.contains(event.target)) close();
}
onMounted(async () => {
  menu.value?.showPopover();
  await nextTick();
  if (disposed) return;
  place();
  menu.value?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  window.addEventListener("resize", close);
  document.addEventListener("scroll", externalScroll, true);
});
onScopeDispose(() => {
  disposed = true;
  const restore = menu.value?.contains(document.activeElement);
  menu.value?.hidePopover();
  window.removeEventListener("resize", close);
  document.removeEventListener("scroll", externalScroll, true);
  if (restore && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <div ref="menu" popover="auto" role="menu" class="message-context-menu"
      :aria-label="label" @toggle="toggled" @keydown="keys" @contextmenu.prevent>
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.message-context-menu {
  position: fixed;
  inset: auto;
  margin: 0;
  padding: 5px 0;
  width: 178px;
  max-width: calc(100vw - 12px);
  max-height: calc(100vh - 12px);
  overflow: auto;
  border: 1px solid var(--ui-line);
  border-radius: 7px;
  background: var(--ui-surface);
  color: var(--ui-text);
  box-shadow: 0 5px 24px #0003;
}
.message-context-menu :deep(button) {
  display: flex;
  align-items: center;
  gap: 13px;
  width: 100%;
  min-height: 32px;
  padding: 5px 12px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font-size: 13px;
  text-align: start;
}
.message-context-menu :deep(button:hover),
.message-context-menu :deep(button:focus-visible) { background: var(--ui-fill); outline-offset: -2px; }
.message-context-menu :deep(button:disabled) { opacity: .45; }
.message-context-menu :deep(.ui-icon) { font-size: 17px; color: var(--ui-muted); }
.message-context-menu :deep(.message-menu-time) {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  padding: 9px 12px 4px;
  border-top: 1px solid var(--ui-line);
  font-size: 12px;
  color: var(--ui-muted);
}
</style>
