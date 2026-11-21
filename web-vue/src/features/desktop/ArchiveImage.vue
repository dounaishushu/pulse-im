<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, shallowRef, useTemplateRef } from "vue";
import UiIcon from "../../components/UiIcon.vue";
import platform from "virtual:pulse-platform";
import type { DesktopArchiveWindow } from "../../platform/contracts";

const { archive } = defineProps<{ archive: DesktopArchiveWindow }>();
const stage = useTemplateRef<HTMLElement>("stage");
const source = shallowRef("");
const name = shallowRef("图片预览");
const issue = shallowRef("");
const feedback = shallowRef("");
const size = shallowRef<{ width: number; height: number }>();
const zoom = shallowRef(1);
const offset = shallowRef({ x: 0, y: 0 });
const fitting = shallowRef(true);
const copying = shallowRef(false);
const percent = computed(() => Math.round(zoom.value * 100) + "%");
const dimensions = computed(() => size.value ? `${size.value.width} × ${size.value.height} 像素` : "");
const imageStyle = computed(() => ({ transform: `translate3d(${offset.value.x}px, ${offset.value.y}px, 0) scale(${zoom.value})` }));
let drag: { id: number; x: number; y: number } | undefined;
let unsubscribe: (() => void) | undefined;
let observer: ResizeObserver | undefined;
let disposed = false;
let revision = 0;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
const failure = (cause: unknown) => typeof cause === "string" ? cause : "暂时无法读取图片，请重试。";

function position(x: number, y: number) {
  if (!stage.value || !size.value) return;
  const w = Math.max(0, (size.value.width * zoom.value - stage.value.clientWidth) / 2);
  const h = Math.max(0, (size.value.height * zoom.value - stage.value.clientHeight) / 2);
  offset.value = { x: Math.max(-w, Math.min(w, x)), y: Math.max(-h, Math.min(h, y)) };
}

function fit() {
  if (!stage.value || !size.value) return;
  fitting.value = true;
  zoom.value = Math.max(.01, Math.min(1, (stage.value.clientWidth - 24) / size.value.width,
    (stage.value.clientHeight - 24) / size.value.height));
  position(0, 0);
}

function magnify(factor: number, point?: { x: number; y: number }) {
  if (!size.value) return;
  const old = zoom.value;
  zoom.value = Math.max(Math.min(.05, old), Math.min(8, factor));
  fitting.value = false;
  const focus = point || { x: 0, y: 0 };
  const ratio = zoom.value / old;
  position(focus.x + (offset.value.x - focus.x) * ratio, focus.y + (offset.value.y - focus.y) * ratio);
}

function actual() {
  magnify(1);
  position(0, 0);
}

function wheel(event: WheelEvent) {
  if (!size.value || !stage.value || event.deltaY === 0) return;
  const bounds = stage.value.getBoundingClientRect();
  magnify(zoom.value * (event.deltaY < 0 ? 1.15 : 1 / 1.15), {
    x: event.clientX - bounds.left - bounds.width / 2,
    y: event.clientY - bounds.top - bounds.height / 2,
  });
}

function pointerDown(event: PointerEvent) {
  if (!size.value || event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag = { id: event.pointerId, x: event.clientX - offset.value.x, y: event.clientY - offset.value.y };
}

function pointerMove(event: PointerEvent) {
  if (drag?.id === event.pointerId) position(event.clientX - drag.x, event.clientY - drag.y);
}

async function load() {
  const selected = ++revision;
  source.value = "";
  issue.value = "";
  feedback.value = "";
  name.value = "图片预览";
  size.value = undefined;
  drag = undefined;
  try {
    const image = await archive.image();
    if (disposed || selected !== revision) return;
    name.value = image.name || "图片预览";
    source.value = platform.mediaSource ? platform.mediaSource(image.url) : image.url;
    if (!source.value) issue.value = "暂时无法读取图片，请重试。";
  } catch (cause) {
    if (!disposed && selected === revision) issue.value = failure(cause);
  }
}

async function loaded(event: Event) {
  const element = event.target as HTMLImageElement;
  if (!source.value || source.value !== element.getAttribute("src")) return;
  size.value = { width: element.naturalWidth, height: element.naturalHeight };
  await nextTick();
  fit();
}

async function copyImage() {
  if (copying.value || !size.value) return;
  const selected = revision;
  copying.value = true;
  clearTimeout(feedbackTimer);
  try {
    await archive.copyImage();
    if (!disposed && selected === revision) feedback.value = "图片已复制";
  } catch (cause) {
    if (!disposed && selected === revision) feedback.value = failure(cause);
  } finally {
    copying.value = false;
    if (!disposed && selected === revision)
      feedbackTimer = setTimeout(() => { feedback.value = ""; }, 3500);
  }
}

function close() { void archive.close().catch(() => {}); }
function keyboard(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    void copyImage();
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && ["+", "=", "-", "0"].includes(event.key)) {
    event.preventDefault();
    if (event.key === "0") fit();
    else magnify(zoom.value * (event.key === "-" ? .8 : 1.25));
  }
}

onMounted(async () => {
  window.addEventListener("keydown", keyboard);
  observer = new ResizeObserver(() => {
    if (fitting.value) fit();
    else position(offset.value.x, offset.value.y);
  });
  if (stage.value) observer.observe(stage.value);
  try {
    const release = await archive.onImageChange(load);
    if (disposed) { release(); return; }
    unsubscribe = release;
    if (!revision) await load();
  } catch (cause) {
    if (!disposed) issue.value = failure(cause);
  }
});
onScopeDispose(() => {
  disposed = true;
  clearTimeout(feedbackTimer);
  window.removeEventListener("keydown", keyboard);
  observer?.disconnect();
  unsubscribe?.();
});
</script>

<template>
  <section class="archive-image" data-theme="night" aria-label="图片预览">
    <header class="image-header">
      <div><h1 :title="name">{{ name }}</h1><small v-if="dimensions">{{ dimensions }}</small></div>
      <button type="button" aria-label="关闭图片预览" title="关闭（Esc）" @click="close"><UiIcon name="close" /></button>
    </header>
    <div ref="stage" class="image-stage" @wheel.prevent="wheel">
      <div v-if="source && !issue" class="image-center">
        <img :key="source" :src="source" :alt="name" :style="imageStyle" :class="{ ready: !!size }" draggable="false"
          @load="loaded" @error="issue = '图片加载失败。'" @dblclick="fitting ? actual() : fit()"
          @pointerdown="pointerDown" @pointermove="pointerMove" @lostpointercapture="drag = undefined" />
      </div>
      <p v-if="!size && !issue" role="status">正在加载图片…</p>
      <div v-if="issue" class="image-retry"><p role="alert">{{ issue }}</p><button type="button" @click="load">重新加载</button></div>
    </div>
    <footer class="image-tools">
      <div role="group" aria-label="图片缩放">
        <button type="button" :disabled="!size" aria-label="缩小图片" @click="magnify(zoom * .8)"><UiIcon name="minus" /></button>
        <output>{{ size ? percent : "–" }}</output>
        <button type="button" :disabled="!size" aria-label="放大图片" @click="magnify(zoom * 1.25)"><UiIcon name="plus" /></button>
      </div>
      <button type="button" :disabled="!size" @click="actual">原始大小</button>
      <button type="button" :disabled="!size" :aria-pressed="fitting" @click="fit">适应窗口</button>
      <span class="image-feedback" role="status">{{ feedback }}</span>
      <button type="button" :disabled="!size || copying" title="复制图片（Ctrl+C）" @click="copyImage">{{ copying ? '正在复制…' : '复制图片' }}</button>
    </footer>
  </section>
</template>

<style scoped>
.archive-image { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
.image-header, .image-tools { display: flex; align-items: center; gap: 8px; padding: 9px 13px; }
.image-header { justify-content: space-between; border-bottom: 1px solid var(--ui-line); }
.image-header div { min-width: 0; }
.image-header h1 { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.image-header small, .image-tools output { color: var(--ui-muted); font-size: 12px; }
.image-stage { min-width: 0; position: relative; overflow: hidden; display: grid; place-items: center; background: #14171d; text-align: center; }
.image-stage:has(.image-center) { touch-action: none; }
.image-center { position: absolute; inset: 0; display: grid; align-items: center; justify-items: center; grid-template: minmax(0, 1fr) / minmax(0, 1fr); overflow: hidden; }
.image-center img { pointer-events: none; visibility: hidden; max-width: none; max-height: none; }
.image-center img.ready { pointer-events: auto; visibility: visible; transform-origin: center; cursor: grab; user-select: none; }
.image-center img.ready:active { cursor: grabbing; }
.image-retry { display: grid; justify-items: center; gap: 10px; }
.image-retry button { background: var(--ui-fill); }
.image-tools { border-top: 1px solid var(--ui-line); font-size: 13px; flex-wrap: wrap; }
.image-tools > div { display: inline-flex; align-items: center; gap: 3px; }
.image-tools output { min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; }
.image-tools button[aria-pressed="true"] { background: var(--ui-fill); }
.image-feedback { flex: 1 1 10px; min-width: 0; color: var(--ui-primary); font-size: 12px; text-align: center; overflow-wrap: anywhere; }
</style>
