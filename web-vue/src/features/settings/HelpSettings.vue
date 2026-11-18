<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
const {} = useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <h3>常见问题 / 我有疑问</h3>
    <p>
      网络不稳定时，文字消息保存在本机待发队列。请保留设备数据，恢复网络后会自动重试。浏览器权限可在地址栏的网站设置调整。
    </p>
    <p>原服务没有提供在线客服或帮助工单接口。</p>
  </div>
</template>
