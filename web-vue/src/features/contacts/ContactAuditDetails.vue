<script setup lang="ts">
import { computed } from "vue";

import type { ContactAudit } from "../../api/types";
import { ipLocationSource, ipLocationText } from "./ipLocation";

const props = defineProps<{ details: ContactAudit }>();
const platforms: Record<string, string> = { pc: "电脑客户端", windows: "Windows", web: "网页端", android: "Android", ios: "iOS" };
const time = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const fields = computed(() => {
  const audit = props.details;
  const seen = Date.parse(audit.last_login_at || "");
  const device = audit.last_login_device || audit.login_history?.[0]?.platform || "";
  return [
    ["最近登录", Number.isFinite(seen) ? time.format(seen) : "暂无记录"],
    ["登录设备", (Object.hasOwn(platforms, device) && platforms[device]) || device || "暂无记录"],
    ["IP 地址", audit.last_login_ip || "暂无记录"],
    ["IP 归属地", ipLocationText(audit.last_login_ip, audit.last_login_location, audit.last_login_location_status, audit.last_login_location_detail), ipLocationSource(audit.last_login_location_detail)],
    ["注册 IP 地址", audit.register_ip || "暂无记录"],
    ["注册 IP 归属地", ipLocationText(audit.register_ip, audit.register_ip_location, audit.register_ip_location_status, audit.register_ip_location_detail), ipLocationSource(audit.register_ip_location_detail)],
  ];
});
</script>

<template>
  <details>
    <summary>登录与注册信息</summary>
    <dl class="vue-details">
      <template v-for="[label, value, source] in fields" :key="label">
        <dt>{{ label }}</dt><dd :title="source">{{ value }}</dd>
      </template>
    </dl>
  </details>
</template>
