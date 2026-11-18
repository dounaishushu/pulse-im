<script setup lang="ts">
import { computed } from "vue";
import { formatTime, platforms } from "../../domain/catalog";

interface Observation {
  observed_ip: string;
  exit_ip?: string | null;
  risk_score?: number | null;
  is_residential?: boolean | null;
  is_broadcast?: boolean | null;
  checked_at: string;
  platform?: string;
  client_version?: string;
}
const props = defineProps<{ report?: Observation | null; loginIp?: string }>();
const risk = computed(() => typeof props.report?.risk_score === "number"
  ? `风险 ${props.report.risk_score} / 100` : "风险未测得");
const route = computed(() => {
  const report = props.report;
  if (!report?.exit_ip) return "";
  return [report.is_residential == null ? "" : report.is_residential ? "住宅线路" : "非住宅线路",
    report.is_broadcast == null ? "" : report.is_broadcast ? "广播 IP" : "非广播 IP"].filter(Boolean).join(" · ");
});
</script>

<template>
  <div v-if="report" class="network-cell">
    <div v-if="report.exit_ip" class="address" title="客户端通过 IPPure 上报">出口 {{ report.exit_ip }}</div>
    <div class="text-xs muted address">连接 {{ report.observed_ip }}</div>
    <div class="text-xs">{{ [risk, route].filter(Boolean).join(" · ") }}</div>
    <div class="text-xs muted">{{ [platforms[report.platform || ""], report.client_version, formatTime(report.checked_at)].filter(Boolean).join(" · ") }}</div>
  </div>
  <div v-else-if="loginIp" class="network-cell">
    <div class="address">登录 {{ loginIp }}</div>
    <div class="text-xs muted">暂无出口检测</div>
  </div>
  <span v-else class="muted">—</span>
</template>

<style scoped>
.network-cell { line-height: 1.5; padding-block: 3px; }
.address { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
</style>
