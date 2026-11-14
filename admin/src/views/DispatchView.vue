<script setup lang="ts">
import { shallowRef, reactive, onMounted } from "vue";
import { post } from "../api/client";
import { can } from "../stores/session";
import { usePageData } from "../composables/usePageData";
import { useAction, confirmAction } from "../composables/useAction";
import type { RecordData, TableColumn } from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import ArtIcon from "../components/ArtIcon.vue";
import ArtTable from "../components/ArtTable.vue";
import TablePagination from "../components/TablePagination.vue";
import DispatchEditor from "../features/dispatch/DispatchEditor.vue";
const { data, loading, error, page, pageSize, load } = usePageData(
    "/admin/dispatch-tasks",
  ),
  action = useAction();
const filters = reactive({ q: "", status: "", trigger_type: "" }),
  editor = shallowRef(false),
  editing = shallowRef<RecordData | null>(null),
  readonly = shallowRef(false);
const statuses: Record<string, string> = {
  pending: "待执行",
  running: "执行中",
  completed: "已完成",
  paused: "已暂停",
  failed: "执行失败",
};
const columns: TableColumn[] = [
  { key: "name", label: "任务名称", minWidth: 180 },
  {
    key: "sender",
    label: "发送者",
    minWidth: 145,
    format: (r) => r.sender?.name || r.sender?.nickname || "#" + r.sender_id,
  },
  {
    key: "recipient_type",
    label: "接收对象",
    minWidth: 140,
    format: (r) =>
      `${r.recipient_type === "user" ? "用户" : "群组"} · ${r.recipient_ids?.length || r.recipients?.length || 0} 个`,
  },
  { key: "step_count", label: "步骤数", width: 100 },
  { key: "trigger", label: "执行计划", minWidth: 210 },
  {
    key: "status",
    label: "状态",
    width: 110,
    format: (r) => statuses[r.status] || r.status,
    tag: (r) =>
      r.status === "pending"
        ? "success"
        : r.status === "failed"
          ? "danger"
          : r.status === "running"
            ? "warning"
            : "info",
  },
  { key: "updated_at", label: "更新时间", minWidth: 170 },
];
function reload(reset = false) {
  return load(filters, reset);
}
function edit(row: RecordData | null = null, read = false) {
  editing.value = row;
  readonly.value = read;
  editor.value = true;
}
async function toggle(row: RecordData) {
  if (!can("dispatch-tasks", true)) return;
  const status = ["paused", "failed"].includes(row.status)
    ? "pending"
    : "paused";
  if (
    !(await confirmAction(
      `确认${status === "paused" ? "暂停" : "启用"}此分发任务？`,
    ))
  )
    return;
  await action.run(async () => {
    await post("/admin/dispatch-tasks/status", { id: row.id, status });
    await reload();
  }, "任务状态已更新");
}
async function remove(row: RecordData) {
  if (
    !can("dispatch-tasks", true) ||
    !(await confirmAction(
      "确认删除此分发任务？未执行的发送将被取消，已发送消息会保留。",
    ))
  )
    return;
  await action.run(async () => {
    await post("/admin/dispatch-tasks/delete", { id: row.id });
    await reload();
  }, "任务已删除");
}
function executeTime(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
onMounted(() => reload());
</script>
<template>
  <PageHeader title="分发任务"
    ><el-button
      v-if="can('dispatch-tasks', true)"
      type="primary"
      @click="edit()"
      ><ArtIcon name="Plus" :size="15" />新增分发任务</el-button
    ></PageHeader
  >
  <section class="art-card section-card">
    <form class="filters" @submit.prevent="reload(true)">
      <label
        >任务检索<el-input
          v-model="filters.q"
          placeholder="搜索任务名称"
          clearable /></label
      ><label
        >执行状态<el-select
          v-model="filters.status"
          clearable
          placeholder="全部状态"
          ><el-option
            v-for="(label, key) in statuses"
            :key="key"
            :label="label"
            :value="key" /></el-select></label
      ><label
        >触发方式<el-select
          v-model="filters.trigger_type"
          clearable
          placeholder="全部"
          ><el-option label="指定时间" value="once" /><el-option
            label="Cron 定时"
            value="cron" /></el-select
      ></label>
      <div class="filter-actions">
        <el-button type="primary" native-type="submit">查询</el-button
        ><el-button
          @click="
            Object.assign(filters, { q: '', status: '', trigger_type: '' });
            reload(true);
          "
          >重置</el-button
        >
      </div>
    </form>
    <ArtTable
      :rows="data.items"
      :columns="columns"
      :loading="loading"
      :error="error"
      :action-width="245"
      @retry="reload()"
      ><template #trigger="{ row }"
        ><span>{{
          row.trigger_type === "cron" ? "Cron 定时" : "指定时间"
        }}</span>
        <p class="text-xs muted">
          {{
            row.trigger_type === "cron"
              ? row.cron_expression
              : executeTime(row.execute_at)
          }}
          · 北京时间
        </p></template
      ><template #actions="{ row }"
        ><el-button link type="primary" @click="edit(row, true)">查看</el-button
        ><template v-if="can('dispatch-tasks', true)"
          ><el-button link type="primary" @click="edit(row)">编辑</el-button
          ><el-button
            link
            :type="row.status === 'paused' ? 'success' : 'warning'"
            :disabled="
              action.busy.value ||
              (row.status === 'completed' && row.trigger_type === 'once')
            "
            @click="toggle(row)"
            >{{
              ["paused", "failed"].includes(row.status) ? "启用" : "暂停"
            }}</el-button
          ><el-button
            link
            type="danger"
            :disabled="action.busy.value"
            @click="remove(row)"
            >删除</el-button
          ></template
        ></template
      ></ArtTable
    ><TablePagination
      :total="data.total"
      :page="page"
      :size="pageSize"
      :has-more="data.has_more"
      :loading="loading"
      @change="
        (p, s) => {
          page = p;
          pageSize = s;
          reload();
        }
      "
    />
  </section>
  <DispatchEditor
    v-model="editor"
    :task="editing"
    :readonly="readonly"
    @saved="reload()"
  />
</template>
