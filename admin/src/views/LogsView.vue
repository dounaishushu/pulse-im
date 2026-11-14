<script setup lang="ts">
import { shallowRef, onMounted, onBeforeUnmount } from "vue";
import { get, query } from "../api/client";
import { platforms, formatTime } from "../domain/catalog";
import { auditLabel, auditDetail } from "../features/logs/audit";
import type { TableColumn, RecordData, PageResult } from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import ArtTable from "../components/ArtTable.vue";
import TablePagination from "../components/TablePagination.vue";
import RecordDetail from "../components/RecordDetail.vue";
const kind = shallowRef("login"),
  page = shallowRef(1),
  size = shallowRef(50),
  data = shallowRef<PageResult>({ items: [], total: 0, page: 1, size: 50 }),
  loading = shallowRef(false),
  error = shallowRef(""),
  detail = shallowRef<RecordData | null>(null);
let controller: AbortController | undefined,
  sequence = 0;
const loginColumns: TableColumn[] = [
  { key: "user_id", label: "用户编号", minWidth: 200 },
  { key: "account", label: "账号", minWidth: 140 },
  {
    key: "platform",
    label: "登录端",
    width: 110,
    format: (r) =>
      platforms[r.platform || r.device_type] ||
      r.platform ||
      r.device_type ||
      "—",
  },
  { key: "ip", label: "IP 地址", minWidth: 160 },
  {
    key: "success",
    label: "结果",
    width: 110,
    format: (r) => (r.success ? "成功" : "失败"),
    tag: (r) => (r.success ? "success" : "danger"),
  },
  {
    key: "created_at",
    label: "时间",
    minWidth: 180,
    format: (r) => formatTime(r.created_at),
  },
];
const auditColumns: TableColumn[] = [
  { key: "action", label: "操作", minWidth: 190, format: auditLabel },
  {
    key: "target_type",
    label: "目标",
    minWidth: 190,
    format: (r) => `${r.target_type || "—"} ${r.target_id || ""}`,
  },
  { key: "admin_id", label: "管理员", minWidth: 200 },
  { key: "ip", label: "IP 地址", minWidth: 160 },
  {
    key: "detail",
    label: "详情",
    minWidth: 220,
    format: (r) => JSON.stringify(auditDetail(r)),
  },
  {
    key: "created_at",
    label: "时间",
    minWidth: 180,
    format: (r) => formatTime(r.created_at),
  },
];
async function load(reset = false) {
  if (reset) page.value = 1;
  controller?.abort();
  controller = new AbortController();
  const id = ++sequence;
  loading.value = true;
  error.value = "";
  try {
    const result = await get<PageResult>(
      query(
        kind.value === "login" ? "/admin/login-logs" : "/admin/audit-logs",
        {
          page: page.value,
          size: size.value,
          ...(kind.value === "client" ? { action: "client.diagnostics" } : {}),
        },
      ),
      controller.signal,
    );
    if (id === sequence) data.value = result;
  } catch (e: any) {
    if (id === sequence && e.name !== "AbortError") error.value = e.message;
  } finally {
    if (id === sequence) loading.value = false;
  }
}
onMounted(() => load());
onBeforeUnmount(() => {
  sequence++;
  controller?.abort();
});
</script>
<template>
  <PageHeader title="系统日志" />
  <section class="art-card section-card">
    <el-tabs v-model="kind" @tab-change="load(true)"
      ><el-tab-pane label="登录日志" name="login" /><el-tab-pane
        label="客户端日志"
        name="client" /><el-tab-pane label="操作审计" name="audit" /></el-tabs
    ><ArtTable
      :rows="data.items"
      :columns="kind === 'login' ? loginColumns : auditColumns"
      :loading="loading"
      :error="error"
      :action-width="80"
      @retry="load()"
      ><template #actions="{ row }"
        ><el-button
          link
          type="primary"
          @click="detail = kind === 'login' ? row : auditDetail(row)"
          >详情</el-button
        ></template
      ></ArtTable
    ><TablePagination
      :total="data.total"
      :page="page"
      :size="size"
      :loading="loading"
      :has-more="data.has_more"
      @change="
        (p, s) => {
          page = p;
          size = s;
          load();
        }
      "
    />
  </section>
  <el-drawer
    :model-value="!!detail"
    title="日志详情"
    size="760px"
    @close="detail = null"
    ><RecordDetail v-if="detail" :record="detail"
  /></el-drawer>
</template>
