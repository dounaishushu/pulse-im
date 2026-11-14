<script setup lang="ts">
import { computed, shallowRef } from "vue";
import {
  registrationProvinceMap,
  registrationProvinceLabels,
  registrationMaritimeBoundary,
} from "../../data/registration-map.js";
import ArtIcon from "../../components/ArtIcon.vue";
const props = defineProps<{
  provinces: { code: string; name: string; count: number }[];
}>();
window.PulseRegistrationMap = registrationProvinceMap;
const values = computed(
  () => new Map(props.provinces.map((r) => [r.code, Number(r.count)])),
);
const max = computed(() =>
  Math.max(1, ...props.provinces.map((r) => Number(r.count))),
);
const zoom = shallowRef(1),
  pan = shallowRef({ x: 0, y: 0 }),
  tip = shallowRef("");
let drag: { x: number; y: number; startX: number; startY: number } | null =
  null;
const viewBox = computed(
  () => `${pan.value.x} ${pan.value.y} ${680 / zoom.value} ${510 / zoom.value}`,
);
function color(code: string) {
  const count = values.value.get(code) || 0;
  return count
    ? ["#dce8ff", "#bfd2ff", "#8cafff", "#5d87ff", "#3d64d6"][
        Math.min(4, Math.ceil((count / max.value) * 4))
      ]
    : "var(--map-empty)";
}
function scale(value: number) {
  zoom.value = Math.min(4, Math.max(1, zoom.value * value));
  if (zoom.value === 1) pan.value = { x: 0, y: 0 };
}
function wheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  scale(event.deltaY < 0 ? 1.1 : 1 / 1.1);
}
function pointerDown(event: PointerEvent) {
  if (zoom.value <= 1) return;
  drag = {
    x: event.clientX,
    y: event.clientY,
    startX: pan.value.x,
    startY: pan.value.y,
  };
  (event.currentTarget as SVGElement).setPointerCapture(event.pointerId);
}
function pointerMove(event: PointerEvent) {
  if (!drag) return;
  const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
  const factor = 680 / rect.width / zoom.value;
  pan.value = {
    x: Math.min(
      660,
      Math.max(-600, drag.startX - (event.clientX - drag.x) * factor),
    ),
    y: Math.min(
      480,
      Math.max(-450, drag.startY - (event.clientY - drag.y) * factor),
    ),
  };
}
function key(event: KeyboardEvent) {
  if (["+", "=", "-", "0", "Home"].includes(event.key)) {
    event.preventDefault();
    if (event.key === "-") scale(1 / 1.2);
    else if (event.key === "0" || event.key === "Home") {
      zoom.value = 1;
      pan.value = { x: 0, y: 0 };
    } else scale(1.2);
  }
}
</script>
<template>
  <div class="map-wrap">
    <div class="map-tools">
      <el-button
        text
        circle
        aria-label="缩小地图"
        :disabled="zoom <= 1"
        @click="scale(1 / 1.2)"
        ><ArtIcon name="Minus" :size="14" /></el-button
      ><span>{{ Math.round(zoom * 100) }}%</span
      ><el-button
        text
        circle
        aria-label="放大地图"
        :disabled="zoom >= 4"
        @click="scale(1.2)"
        ><ArtIcon name="Plus" :size="14" /></el-button
      ><el-button
        text
        size="small"
        @click="
          zoom = 1;
          pan = { x: 0, y: 0 };
        "
        >重置</el-button
      >
    </div>
    <svg
      :viewBox="viewBox"
      class="province-map"
      aria-label="注册用户省份分布，可用按钮或 Ctrl 加滚轮缩放，放大后拖动"
      :style="{ touchAction: zoom > 1 ? 'none' : 'pan-y' }"
      tabindex="0"
      @wheel="wheel"
      @pointerdown="pointerDown"
      @pointermove="pointerMove"
      @pointerup="drag = null"
      @pointercancel="drag = null"
      @keydown="key"
    >
      <path
        v-for="region in registrationProvinceMap"
        :key="region.code"
        :d="region.path"
        :fill="color(region.code)"
        fill-rule="evenodd"
        class="province"
        tabindex="0"
        role="img"
        :aria-label="`${region.name}：${values.get(region.code) || 0} 人`"
        @pointerenter="
          tip = `${region.name} · ${values.get(region.code) || 0} 人`
        "
        @focus="tip = `${region.name} · ${values.get(region.code) || 0} 人`"
      >
        <title>{{ region.name }}：{{ values.get(region.code) || 0 }} 人</title>
      </path>
      <path :d="registrationMaritimeBoundary" class="maritime" />
      <text
        v-for="region in registrationProvinceLabels"
        :key="region.code"
        :x="region.x"
        :y="region.y"
        class="province-label"
        text-anchor="middle"
      >
        {{ region.label }}
      </text>
      <text x="624" y="501" text-anchor="middle" class="province-label">
        南海诸岛
      </text>
    </svg>
    <div class="map-bottom">
      <span class="map-tip" role="status">{{
        tip || "选择省份查看注册人数"
      }}</span><span class="map-legend">低<i />高</span>
    </div>
  </div>
</template>
<style scoped>
.map-wrap {
  position: relative;
  --map-empty: #eef2f8;
}
.dark .map-wrap {
  --map-empty: #303d55;
}
.map-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  position: absolute;
  right: 0;
  top: -3px;
  z-index: 1;
  background: var(--surface);
  border-radius: 5px;
}
.map-tools > span {
  font-size: 10px;
  color: var(--muted);
  min-width: 33px;
  text-align: center;
}
.province-map {
  display: block;
  width: 100%;
  height: clamp(230px, 30dvh, 280px);
  touch-action: pan-y;
}
.province {
  stroke: var(--surface);
  stroke-width: 1.4;
  cursor: pointer;
  outline: none;
}
.province:hover,
.province:focus {
  fill: #7098ff;
  stroke: #5d87ff;
}
.province-label {
  font-size: 9px;
  fill: var(--muted);
  pointer-events: none;
}
.maritime {
  fill: none;
  stroke: var(--muted);
  stroke-width: 1;
}
.map-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.map-tip {
  font-size: 11px;
  color: var(--muted);
}
.map-legend {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: var(--muted);
}
.map-legend i {
  width: 85px;
  height: 5px;
  border-radius: 3px;
  background: linear-gradient(to right, #edf3ff, #5d87ff);
}
@media (max-width: 550px) {
  .province-map {
    height: 230px;
  }
}
</style>
