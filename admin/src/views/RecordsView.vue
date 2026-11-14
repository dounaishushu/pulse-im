<script setup lang="ts">
import { reactive, shallowRef, onMounted, onBeforeUnmount } from "vue";
import { get, download, query } from "../api/client";
import { usePageData } from "../composables/usePageData";
import { useAction } from "../composables/useAction";
import { labelStatus, tagStatus, formatTime, options } from "../domain/catalog";
import type { TableColumn, RecordData } from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import ArtIcon from "../components/ArtIcon.vue";
import ArtTable from "../components/ArtTable.vue";
import TablePagination from "../components/TablePagination.vue";
import RecordReview from "../features/records/RecordReview.vue";
const { data, loading, error, page, pageSize, load } = usePageData(
    "/admin/work-records",
    10,
  ),
  action = useAction();
const filters = reactive({
    user_id: "",
    task_id: "",
    status: "",
    date_from: "",
    date_to: "",
  }),
  tasks = shallowRef<RecordData[]>([]),
  recordId = shallowRef<number | null>(null);
const controller = new AbortController();
const columns: TableColumn[] = [
  { key: "id", label: "记录 ID", width: 90 },
  { key: "user_id", label: "用户 ID", minWidth: 110 },
  { key: "task_name", label: "任务", minWidth: 170 },
  { key: "task_date", label: "日期", minWidth: 130 },
  {
    key: "start_at",
    label: "开始时间",
    minWidth: 170,
    format: (r) => formatTime(r.start_at),
  },
  {
    key: "submitted_at",
    label: "完成时间",
    minWidth: 170,
    format: (r) => formatTime(r.submitted_at),
  },
  { key: "total_questions", label: "总题数", width: 90 },
  { key: "correct_count", label: "答对", width: 85 },
  { key: "wrong_count", label: "答错", width: 85 },
  {
    key: "wage",
    label: "工资（元）",
    width: 110,
    format: (r) => Number(r.wage || 0).toFixed(2),
  },
  {
    key: "status",
    label: "状态",
    width: 110,
    format: (r) => labelStatus(r.status),
    tag: (r) => tagStatus(r.status),
  },
];
function reload(reset = false) {
  return load(filters, reset);
}
function reset() {
  Object.assign(filters, {
    user_id: "",
    task_id: "",
    status: "",
    date_from: "",
    date_to: "",
  });
  void reload(true);
}
onMounted(() => {
  void reload();
  void action.run(async () => {
    const result = await get(
      "/admin/work-records/task-options",
      controller.signal,
    );
    tasks.value = result.items || [];
  });
});
onBeforeUnmount(() => controller.abort());
</script>
<template>
  <PageHeader title="作业记录"
    ><el-button
      :loading="action.busy.value"
      @click="
        action.run(() =>
          download(
            query('/admin/work-records/export', filters),
            '作业记录.xlsx',
          ),
        )
      "
      ><ArtIcon name="Download" :size="15" />导出记录</el-button
    ></PageHeader
  >
  <section class="art-card section-card">
    <form class="filters" @submit.prevent="reload(true)">
      <label
        >用户 ID<el-input
          v-model="filters.user_id"
          placeholder="输入用户 ID"
          clearable /></label
      ><label
        >任务<el-select
          v-model="filters.task_id"
          clearable
          placeholder="全部任务"
          ><el-option
            v-for="task in tasks"
            :key="task.id"
            :value="String(task.id)"
            :label="task.name" /></el-select></label
      ><label
        >状态<el-select v-model="filters.status" clearable placeholder="全部"
          ><el-option
            v-for="item in options({
              in_progress: '进行中',
              pending_review: '待批改',
              reviewed: '已完成',
            })"
            :key="item.value as string"
            :value="item.value"
            :label="item.label" /></el-select></label
      ><label
        >开始日期<el-date-picker
          v-model="filters.date_from"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="开始日期" /></label
      ><label
        >结束日期<el-date-picker
          v-model="filters.date_to"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="结束日期"
      /></label>
      <div class="filter-actions">
        <el-button type="primary" native-type="submit">查询</el-button
        ><el-button @click="reset">重置</el-button>
      </div>
    </form>
    <ArtTable
      :rows="data.items"
      :columns="columns"
      :loading="loading"
      :error="error"
      :action-width="100"
      @retry="reload()"
      ><template #actions="{ row }"
        ><el-button link type="primary" @click="recordId = Number(row.id)"
          >查看详情</el-button
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
  <RecordReview
    :record-id="recordId"
    @close="recordId = null"
    @saved="reload()"
  />
</template>
