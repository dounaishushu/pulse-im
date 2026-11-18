<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
const {
  micActive,
  meter,
  volume,
  inputVolume,
  inputDevice,
  outputDevice,
  mediaOutputs,
  mediaInputs,
  saveAudio,
  testMic,
} = useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <label
      >输出设备<select v-model="outputDevice" @change="saveAudio">
        <option value="default">默认</option>
        <option
          v-for="device in mediaOutputs"
          :key="device.deviceId"
          :value="device.deviceId"
        >
          {{ device.label || "音频输出" }}
        </option>
      </select></label
    ><label
      >输出音量 {{ volume }}%<input
        v-model.number="volume"
        type="range"
        min="0"
        max="100"
        @change="saveAudio" /></label
    ><label
      >输入设备<select v-model="inputDevice" @change="saveAudio">
        <option value="default">默认</option>
        <option
          v-for="device in mediaInputs"
          :key="device.deviceId"
          :value="device.deviceId"
        >
          {{ device.label || "麦克风" }}
        </option>
      </select></label
    ><label
      >输入音量 {{ inputVolume }}%<input
        v-model.number="inputVolume"
        type="range"
        min="0"
        max="100"
        @change="saveAudio" /></label
    ><button @click="testMic">
      {{ micActive ? "停止测试" : "测试麦克风" }}</button
    ><meter
      :value="meter"
      min="0"
      max="100"
      aria-label="实时麦克风音量"
    ></meter>
    <p>系统声音由设备系统设置和浏览器网站权限管理。</p>
  </div>
</template>
