<script setup lang="ts">
import { computed } from "vue";

import type { ContactAudit } from "../../api/types";

const props = defineProps<{ details: ContactAudit }>();
const platforms: Record<string, string> = { pc: "电脑客户端", windows: "Windows", web: "网页端", android: "Android", ios: "iOS" };
function location(ip: string | undefined, name: string | undefined, status: string | undefined) {
  if (!ip) return "暂无记录";
  if (name) return name;
  if (status === "failed") return "归属地查询失败";
  if (status === "unconfigured") return "归属地暂不可用";
  return "暂未查到归属地";
}
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
    ["IP 归属地", location(audit.last_login_ip, audit.last_login_location, audit.last_login_location_status)],
    ["注册 IP 地址", audit.register_ip || "暂无记录"],
    ["注册 IP 归属地", location(audit.register_ip, audit.register_ip_location, audit.register_ip_location_status)],
  ];
});
</script>

<template>
  <details>
    <summary>登录与注册信息</summary>
    <dl class="vue-details">
      <template v-for="[label, value] in fields" :key="label">
        <dt>{{ label }}</dt><dd>{{ value }}</dd>
      </template>
    </dl>
  </details>
</template>
