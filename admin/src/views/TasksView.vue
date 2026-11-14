<script setup lang="ts">
import { shallowRef } from "vue";
import { post } from "../api/client";
import { can } from "../stores/session";
import { useAction, confirmAction } from "../composables/useAction";
import { options, labelStatus, tagStatus } from "../domain/catalog";
import type { RecordData } from "../domain/types";
import CrudPage from "../components/CrudPage.vue";
import type { CrudDefinition } from "../components/CrudPage.vue";
import TaskCodeDialog from "../features/tasks/TaskCodeDialog.vue";
const codeTask = shallowRef<RecordData | null>(null),
  action = useAction();
const definition: CrudDefinition = {
  key: "task-config",
  title: "任务配置",
  endpoint: "/admin/work-tasks",
  deleteEndpoint: "/admin/work-tasks/delete",
  deleteMessage: "确认删除选中的任务？已有作业记录的任务将仅停用。",
  defaults: {
    task_key: "",
    name: "",
    open_time: "09:00",
    estimated_minutes: 20,
    question_count: 20,
    intern_unit_price: "0.000",
    formal_unit_price: "0.000",
    sort_order: 0,
    status: "enabled",
    description: "",
  },
  filters: [
    { key: "key", label: "任务标识" },
    { key: "name", label: "任务名称" },
    {
      key: "status",
      label: "状态",
      type: "select",
      options: options({ enabled: "启用", disabled: "停用" }),
    },
  ],
  fields: (row) => [
    {
      key: "task_key",
      label: "任务标识",
      required: true,
      disabled: !!row.id,
      maxLength: 64,
    },
    { key: "name", label: "任务名称", required: true, maxLength: 120 },
    {
      key: "open_time",
      label: "开放时间（北京时间）",
      type: "time",
      required: true,
    },
    {
      key: "estimated_minutes",
      label: "预计用时（分钟）",
      type: "number",
      min: 1,
      max: 1440,
      required: true,
    },
    { key: "intern_unit_price", label: "实习员工单价（元）", required: true },
    { key: "formal_unit_price", label: "正式员工单价（元）", required: true },
    {
      key: "question_count",
      label: "题目数量",
      type: "number",
      min: 2,
      max: 1000,
      step: 2,
      required: true,
      help: "题量需要为偶数，已创建的作业保留原题量。",
    },
    { key: "sort_order", label: "排序", type: "number", min: 0, max: 100000 },
    {
      key: "status",
      label: "状态",
      type: "select",
      options: options({ enabled: "启用", disabled: "停用" }),
    },
    {
      key: "description",
      label: "任务描述",
      type: "textarea",
      maxLength: 5000,
    },
  ],
  columns: [
    { key: "task_key", label: "任务标识", minWidth: 140 },
    { key: "name", label: "任务名称", minWidth: 170 },
    { key: "open_time", label: "开放时间", minWidth: 130 },
    {
      key: "estimated_minutes",
      label: "预计用时",
      minWidth: 110,
      format: (r) => `${r.estimated_minutes} 分钟`,
    },
    {
      key: "intern_unit_price",
      label: "实习单价",
      minWidth: 120,
      format: (r) => `¥ ${Number(r.intern_unit_price || 0).toFixed(3)}`,
    },
    {
      key: "formal_unit_price",
      label: "正式单价",
      minWidth: 120,
      format: (r) => `¥ ${Number(r.formal_unit_price || 0).toFixed(3)}`,
    },
    { key: "question_count", label: "题量", minWidth: 160 },
    {
      key: "status",
      label: "状态",
      width: 95,
      format: (r) => labelStatus(r.status),
      tag: (r) => tagStatus(r.status),
    },
    {
      key: "open_status",
      label: "开放状态",
      minWidth: 120,
      format: (r) => r.open_status_label || r.open_status || "待开放",
    },
  ],
  prepare: (row) => ({
    ...row,
    open_time: String(row.open_time || "09:00").slice(0, 5),
  }),
  validate(row) {
    if (!/^[A-Za-z0-9_-]+$/.test(row.task_key))
      throw new Error("任务标识只能包含字母、数字、下划线和短横线");
    if (Number(row.question_count) % 2) throw new Error("题目数量必须为偶数");
    for (const key of ["intern_unit_price", "formal_unit_price"])
      if (!/^\d+(\.\d{1,3})?$/.test(String(row[key])))
        throw new Error("单价需要为非负数，最多三位小数");
  },
};
async function toggle(row: RecordData, reload: () => Promise<void>) {
  if (
    !can("task-config", true) ||
    !(await confirmAction(
      `确认${row.status === "enabled" ? "停用" : "启用"}任务 ${row.name}？`,
    ))
  )
    return;
  await action.run(async () => {
    await post("/admin/work-tasks/status", {
      id: row.id,
      status: row.status === "enabled" ? "disabled" : "enabled",
    });
    await reload();
  }, "任务状态已更新");
}
</script>
<template>
  <CrudPage :definition="definition"
    ><template #question_count="{ row }"
      ><strong>{{ row.question_count }} 题</strong>
      <p class="text-xs muted">
        {{ row.question_count / 2 }} 组<span
          v-if="
            row.today_question_count &&
            row.today_question_count !== row.question_count
          "
        >
          · 今日 {{ row.today_question_count }} 题</span
        >
      </p>
      <p v-if="row.question_count_effective_from" class="text-xs muted">
        {{ row.question_count_effective_from }} 起生效
      </p></template
    ><template #row-actions="{ row, reload }"
      ><el-button
        v-if="can('task-config', true)"
        link
        type="primary"
        @click="codeTask = row"
        >验证码</el-button
      ><el-button
        v-if="can('task-config', true)"
        link
        :type="row.status === 'enabled' ? 'warning' : 'success'"
        :disabled="action.busy.value"
        @click="toggle(row, reload)"
        >{{ row.status === "enabled" ? "停用" : "启用" }}</el-button
      ></template
    ></CrudPage
  ><TaskCodeDialog :task="codeTask" @close="codeTask = null" />
</template>
