<script setup lang="ts">
import { shallowRef } from "vue";
import platform from "virtual:pulse-platform";

const diagnostics = platform.diagnostics;
const busy = shallowRef(false);
const error = shallowRef("");
async function openLogs() {
  if (!diagnostics || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await diagnostics.openLogs();
  } catch (cause) {
    error.value = typeof cause === "string" ? cause : "无法打开本地日志目录。";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="vue-settings-section">
    <h3>常见问题 / 我有疑问</h3>
    <p>
      网络不稳定时，文字消息保存在本机待发队列。请保留设备数据，恢复网络后会自动重试。<template v-if="!diagnostics">浏览器权限可在地址栏的网站设置调整。</template>
    </p>
    <button v-if="diagnostics" type="button" :disabled="busy" @click="openLogs">打开本地日志</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p>原服务没有提供在线客服或帮助工单接口。</p>
  </div>
</template>
