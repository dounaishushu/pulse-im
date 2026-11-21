<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, shallowRef, useTemplateRef } from "vue";
import UiIcon from "../../components/UiIcon.vue";
import type { ScreenshotOverlay, ScreenSelection } from "../../platform/contracts";

const props = defineProps<{ overlay: ScreenshotOverlay }>();
const surface = useTemplateRef<HTMLElement>("surface");
const done = useTemplateRef<HTMLButtonElement>("done");
const image = shallowRef("");
const loaded = shallowRef(false);
const selection = shallowRef<{ x: number; y: number; width: number; height: number } | null>(null);
const selected = shallowRef(false);
const pending = shallowRef(false);
const error = shallowRef("");
const display = shallowRef({ width: 0, height: 0 });
const pixels = shallowRef({ width: 0, height: 0 });
const crop = computed<ScreenSelection | null>(() => {
  const box = selection.value;
  const { width, height } = display.value;
  const frame = pixels.value;
  if (!box || !width || !height || !frame.width || !frame.height) return null;
  const horizontal = frame.width / width;
  const vertical = frame.height / height;
  return {
    left: Math.floor(box.x * horizontal),
    top: Math.floor(box.y * vertical),
    right: Math.min(frame.width, Math.ceil((box.x + box.width) * horizontal)),
    bottom: Math.min(frame.height, Math.ceil((box.y + box.height) * vertical)),
  };
});
const displaySize = computed(() => {
  const box = crop.value;
  return box ? `${box.right - box.left} × ${box.bottom - box.top}` : "";
});
const area = computed(() => {
  const box = selection.value;
  if (!box) return;
  return {
    left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`,
  };
});
const toolbar = computed(() => {
  const box = selection.value;
  if (!box) return;
  const { width, height } = display.value;
  const toolbarWidth = Math.min(244, width - 16);
  const left = Math.max(8, Math.min(width - toolbarWidth - 8, box.x + box.width - toolbarWidth));
  const below = box.y + box.height + 8;
  const top = below + 38 <= height - 8 ? below : Math.max(8, box.y - 46);
  return { left: `${left}px`, top: `${top}px`, width: `${toolbarWidth}px` };
});
let origin: { pointer: number; x: number; y: number } | undefined;
let alive = true;
const listeners = new AbortController();
function resize() {
  const bounds = surface.value?.getBoundingClientRect();
  if (!bounds) return;
  if (bounds.width !== display.value.width || bounds.height !== display.value.height) {
    display.value = { width: bounds.width, height: bounds.height };
    origin = undefined;
    selected.value = false;
    selection.value = null;
  }
}
function point(event: PointerEvent) {
  return {
    x: Math.max(0, Math.min(display.value.width, event.clientX)),
    y: Math.max(0, Math.min(display.value.height, event.clientY)),
  };
}
function move(event: PointerEvent) {
  if (!origin || origin.pointer !== event.pointerId) return;
  const { x, y } = point(event);
  selection.value = {
    x: Math.min(x, origin.x), y: Math.min(y, origin.y),
    width: Math.abs(x - origin.x), height: Math.abs(y - origin.y),
  };
}
function start(event: PointerEvent) {
  if (event.button !== 0 || !loaded.value || pending.value || origin ||
      (event.target instanceof Element && event.target.closest(".capture-tools"))) return;
  surface.value?.setPointerCapture(event.pointerId);
  origin = { pointer: event.pointerId, ...point(event) };
  selected.value = false;
  error.value = "";
  move(event);
}
function stop(event: PointerEvent) {
  if (origin?.pointer !== event.pointerId) return;
  move(event);
  origin = undefined;
  const box = selection.value;
  if (!box || box.width < 6 || box.height < 6) {
    selection.value = null;
    return;
  }
  selected.value = true;
  void nextTick(() => done.value?.focus({ preventScroll: true }));
}
function reset(event: PointerEvent) {
  if (origin?.pointer !== event.pointerId) return;
  origin = undefined;
  selected.value = false;
  selection.value = null;
}
async function complete() {
  const box = crop.value;
  if (!box || !selected.value || pending.value) return;
  pending.value = true;
  error.value = "";
  try {
    await props.overlay.complete(box);
  } catch (cause) {
    if (alive) error.value = typeof cause === "string" ? cause : "截图失败，请重新选择范围。";
  } finally {
    pending.value = false;
  }
}
function cancel() { void props.overlay.cancel().catch(() => {}); }
function keys(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
  } else if (event.key === "Enter" && selected.value && !(event.target instanceof HTMLButtonElement)) {
    event.preventDefault();
    void complete();
  }
}
onMounted(async () => {
  resize();
  window.addEventListener("resize", resize, { signal: listeners.signal });
  window.addEventListener("keydown", keys, { signal: listeners.signal });
  try {
    const preview = await props.overlay.preview();
    if (alive) {
      pixels.value = { width: preview.width, height: preview.height };
      image.value = URL.createObjectURL(preview.image);
    }
  } catch {
    if (alive) error.value = "无法读取截图预览，请取消后重试。";
  }
});
onScopeDispose(() => {
  alive = false;
  listeners.abort();
  if (image.value) URL.revokeObjectURL(image.value);
});
</script>

<template>
  <main ref="surface" class="capture-surface" aria-label="屏幕截图"
    @pointerdown="start" @pointermove="move" @pointerup="stop" @pointercancel="reset"
    @lostpointercapture="reset" @contextmenu.prevent="cancel">
    <img v-if="image" class="capture-image" :src="image" alt="" draggable="false" @load="loaded = true" />
    <div v-if="area" class="capture-area" :style="area" aria-hidden="true"></div>
    <div v-else class="capture-shade" aria-hidden="true"></div>
    <p v-if="!selected && !error" class="capture-help" role="status">
      {{ loaded ? '拖动选择截图区域，按 Esc 取消' : '正在准备截图…' }}
    </p>
    <p v-if="error" class="capture-help" role="alert">{{ error }}</p>
    <div v-if="selected" class="capture-tools" :style="toolbar">
      <output class="capture-size" aria-label="截图尺寸">{{ displaySize }}</output>
      <button type="button" @click="cancel"><UiIcon name="close" /> 取消</button>
      <button ref="done" type="button" class="capture-confirm" :disabled="pending" @click="complete">
        <UiIcon name="check" /> {{ pending ? '处理中…' : '完成截图' }}
      </button>
    </div>
    <button v-else type="button" class="capture-tools capture-exit" @click="cancel"><UiIcon name="close" /> 取消</button>
  </main>
</template>

<style scoped>
.capture-surface { position: fixed; inset: 0; overflow: hidden; background: #182230; color: #e9eef6; cursor: crosshair; touch-action: none; user-select: none; font: 14px/1.4 "Segoe UI", "Microsoft YaHei UI", sans-serif; }
.capture-image, .capture-shade { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.capture-shade, .capture-area { --capture-dim: rgb(9 17 29 / 45%); }
.capture-shade { background: var(--capture-dim); }
.capture-area { position: absolute; box-sizing: border-box; border: 2px solid #76b4ff; box-shadow: 0 0 0 200vmax var(--capture-dim); pointer-events: none; }
.capture-help { position: absolute; inset: 18px auto auto 50%; transform: translateX(-50%); margin: 0; padding: 9px 15px; border-radius: 8px; background: #192435; color: #f3f6fa; white-space: nowrap; pointer-events: none; }
.capture-tools { box-sizing: border-box; position: absolute; display: flex; align-items: center; gap: 5px; justify-content: flex-end; padding: 4px; border-radius: 8px; background: #172334; box-shadow: 0 3px 18px #0a111d55; cursor: default; }
.capture-size { margin-inline: 8px auto; font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.capture-exit { top: 18px; right: 18px; }
.capture-tools button, button.capture-exit { min-height: 32px; padding: 0 10px; display: inline-flex; align-items: center; gap: 4px; border: 0; border-radius: 5px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
button.capture-exit { background: #172334; }
.capture-tools button:hover, button.capture-exit:hover { background: #2a3b53; }
.capture-tools .capture-confirm { background: #246bcb; color: #fff; }
.capture-tools .capture-confirm:hover { background: #2c7de7; }
.capture-tools button:focus-visible, button.capture-exit:focus-visible { outline: 2px solid #9dccff; outline-offset: -2px; }
.capture-surface :deep(.ui-icon) { display: inline-flex; }
.capture-surface :deep(.ui-icon svg) { width: 1em; height: 1em; }
</style>
