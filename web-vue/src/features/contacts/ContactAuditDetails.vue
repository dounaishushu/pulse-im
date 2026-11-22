<script setup lang="ts">
import { computed } from "vue";

import type { ContactAudit } from "../../api/types";
import UiIcon from "../../components/UiIcon.vue";
import { ipLocationSource, ipLocationText } from "./ipLocation";

const props = defineProps<{ details: ContactAudit; disabled?: boolean }>();
const emit = defineEmits<{ copy: [key: "register_ip" | "last_login_ip"] }>();
const platforms: Record<string, string> = { pc: "PC", windows: "Windows", web: "Web", android: "安卓", ios: "iOS" };
const time = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const fields = computed(() => {
  const audit = props.details;
  const seen = Date.parse(audit.last_login_at || "");
  const platform = audit.login_history?.[0]?.platform || "";
  const platformName = (Object.hasOwn(platforms, platform) && platforms[platform]) || platform;
  const device = audit.last_login_device || "";
  const deviceName = (Object.hasOwn(platforms, device) && platforms[device]) || device;
  return [
    { label: "登录设备", value: [platformName, deviceName].filter((part, index, all) => part && all.indexOf(part) === index).join(" · ") || "暂无记录" },
    { label: "注册 IP 地址", value: audit.register_ip || "暂无记录", copy: audit.register_ip ? "register_ip" as const : undefined },
    { label: "注册归属地", value: ipLocationText(audit.register_ip, audit.register_ip_location, audit.register_ip_location_status, audit.register_ip_location_detail), source: ipLocationSource(audit.register_ip_location_detail) },
    { label: "登录 IP 地址", value: audit.last_login_ip || "暂无记录", copy: audit.last_login_ip ? "last_login_ip" as const : undefined },
    { label: "登录归属地", value: ipLocationText(audit.last_login_ip, audit.last_login_location, audit.last_login_location_status, audit.last_login_location_detail), source: ipLocationSource(audit.last_login_location_detail) },
    { label: "最近登录", value: Number.isFinite(seen) ? time.format(seen) : "暂无记录" },
  ];
});
</script>

<template>
  <section class="contact-audit" aria-label="登录与注册信息">
    <dl class="contact-audit-fields">
      <template v-for="field in fields" :key="field.label">
        <dt>{{ field.label }}</dt>
        <dd :title="field.source">
          <span>{{ field.value }}</span>
          <button v-if="field.copy" type="button" class="ui-icon-button" :aria-label="'复制' + field.label" :title="'复制' + field.label" :disabled="disabled" @click="emit('copy', field.copy)"><UiIcon name="copy" /></button>
        </dd>
      </template>
    </dl>
  </section>
</template>

<style scoped>
.contact-audit { border-top: 1px solid var(--ui-line); padding-top: 14px; }
.contact-audit-fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 9px 14px; font-size: 13px; line-height: 1.6; }
.contact-audit-fields dt { color: var(--ui-muted); align-self: center; }
.contact-audit-fields dd { display: flex; align-items: center; justify-content: flex-end; gap: 5px; min-width: 0; text-align: end; }
.contact-audit-fields dd span { overflow-wrap: anywhere; }
.contact-audit-fields .ui-icon-button { width: 24px; height: 24px; font-size: 14px; }
</style>
