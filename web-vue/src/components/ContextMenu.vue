<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, useTemplateRef } from "vue";

const props = defineProps<{
  id?: string;
  point?: { x: number; y: number };
  anchor?: HTMLElement;
  label: string;
  compact?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();
const menu = useTemplateRef<HTMLElement>("menu");
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
let disposed = false;
let frame = 0;
let observer: ResizeObserver | undefined;
const origin = props.anchor?.getBoundingClientRect();
const offset = origin && props.point ? {
  x: (props.point.x - origin.left) / (origin.width || 1),
  y: (props.point.y - origin.top) / (origin.height || 1),
} : undefined;
function place() {
  const element = menu.value;
  if (!element || disposed) return;
  if (props.anchor && !props.anchor.isConnected) { close(); return; }
  // Mouse coordinates include interface zoom; fixed CSS coordinates do not.
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const width = window.innerWidth / zoom;
  const height = window.innerHeight / zoom;
  const bounds = props.anchor?.getBoundingClientRect();
  const x = (bounds ? bounds.left + bounds.width * (offset?.x ?? 0) :
    props.point?.x ?? window.innerWidth / 2) / zoom;
  const y = (bounds ? bounds.top + bounds.height * (offset?.y ?? 1) :
    props.point?.y ?? window.innerHeight / 2) / zoom;
  element.style.left = `${Math.max(6, Math.min(x, width - element.offsetWidth - 6))}px`;
  element.style.top = `${Math.max(6, Math.min(y, height - element.offsetHeight - 6))}px`;
}
function schedulePlace() {
  if (!frame && !disposed) frame = requestAnimationFrame(() => { frame = 0; place(); });
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
  // Incoming messages scroll a different pane. Only follow our own anchor;
  // unrelated scrolling must not dismiss an operation the user is choosing.
  if (props.anchor && event.target instanceof Node && event.target.contains(props.anchor)) schedulePlace();
}
onMounted(async () => {
  menu.value?.showPopover();
  await nextTick();
  if (disposed) return;
  place();
  (menu.value?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') || menu.value)?.focus({ preventScroll: true });
  observer = new ResizeObserver(schedulePlace);
  if (menu.value) observer.observe(menu.value);
  if (props.anchor) {
    observer.observe(props.anchor);
    const dialog = props.anchor.closest(".vue-dialog");
    if (dialog) observer.observe(dialog);
  }
  window.addEventListener("resize", schedulePlace);
  document.addEventListener("scroll", externalScroll, true);
});
onScopeDispose(() => {
  disposed = true;
  const restore = menu.value?.contains(document.activeElement);
  menu.value?.hidePopover();
  cancelAnimationFrame(frame);
  observer?.disconnect();
  window.removeEventListener("resize", schedulePlace);
  document.removeEventListener("scroll", externalScroll, true);
  if (restore && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <div :id="id" ref="menu" popover="auto" role="menu" tabindex="-1" class="message-context-menu"
      :class="{ 'compact-context-menu': compact }"
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
.compact-context-menu {
  width: 112px;
  padding: 4px;
  border-radius: 4px;
  box-shadow: 0 3px 12px #0002;
}
.compact-context-menu :deep(button) {
  gap: 6px;
  padding: 6px 7px;
  white-space: nowrap;
}
.compact-context-menu :deep(.ui-icon) { font-size: 14px; }
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
