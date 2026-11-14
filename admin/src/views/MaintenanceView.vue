<script setup lang="ts">
import {
  shallowRef,
  watch,
  onMounted,
  onBeforeUnmount,
  useTemplateRef,
} from "vue";
import { get, post, query } from "../api/client";
import { can } from "../stores/session";
import { usePageData } from "../composables/usePageData";
import { useAction, confirmAction } from "../composables/useAction";
import type {
  RecordData,
  PageResult,
  FormField,
  TableColumn,
} from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import ArtIcon from "../components/ArtIcon.vue";
import ArtTable from "../components/ArtTable.vue";
import SchemaForm from "../components/SchemaForm.vue";
import TablePagination from "../components/TablePagination.vue";
import RecordDetail from "../components/RecordDetail.vue";
const plan = shallowRef<RecordData>({}),
  status = shallowRef<RecordData>({}),
  days = shallowRef(180),
  cacheDays = shallowRef(90),
  preview = shallowRef<PageResult | null>(null),
  cache = shallowRef<RecordData | null>(null),
  selection = shallowRef<RecordData[]>([]),
  detail = shallowRef<RecordData | null>(null),
  loading = shallowRef(false),
  previewLoading = shallowRef(false),
  error = shallowRef("");
const action = useAction(),
  history = usePageData("/admin/maintenance/runs"),
  form = useTemplateRef<InstanceType<typeof SchemaForm>>("form");
const controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined,
  previewSequence = 0;
const statuses: Record<string, string> = {
  queued: "等待执行",
  pending: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  partial: "部分完成",
  cancelled: "已取消",
};
const fields: FormField[] = [
  { key: "enabled", label: "启用定时清理", type: "switch", wide: true },
  { key: "interval_days", label: "间隔天数", type: "number", min: 1, max: 30 },
  {
    key: "run_time",
    label: "执行时间（北京时间）",
    type: "time",
    required: true,
  },
  {
    key: "clean_accounts",
    label: "清理长期未上线的普通账号",
    type: "switch",
    wide: true,
  },
  {
    key: "inactive_days",
    label: "未上线天数",
    type: "number",
    min: 1,
    max: 3650,
  },
  { key: "clean_cache", label: "清理过期缓存", type: "switch" },
  {
    key: "cache_days",
    label: "凭据与日志保留天数",
    type: "number",
    min: 7,
    max: 365,
  },
];
const candidateColumns: TableColumn[] = [
  { key: "username", label: "账号", minWidth: 150 },
  { key: "nickname", label: "昵称", minWidth: 150 },
  { key: "last_active_at", label: "最近活跃时间", minWidth: 190 },
  { key: "offline_days", label: "未上线天数", width: 130 },
];
const historyColumns: TableColumn[] = [
  { key: "id", label: "任务编号", width: 110 },
  {
    key: "trigger_type",
    label: "来源",
    width: 100,
    format: (r) => (r.trigger_type === "scheduled" ? "定时" : "手动"),
  },
  {
    key: "status",
    label: "状态",
    width: 130,
    format: (r) => statuses[r.status] || r.status,
    tag: (r) =>
      r.status === "completed"
        ? "success"
        : r.status === "failed"
          ? "danger"
          : "warning",
  },
  { key: "deleted_count", label: "清理账号", width: 110 },
  { key: "skipped_count", label: "跳过账号", width: 110 },
  { key: "cleanup_items", label: "过期数据 / 文件", minWidth: 150 },
  {
    key: "created_at",
    label: "执行时间",
    minWidth: 180,
    format: (r) => r.finished_at || r.started_at || r.created_at,
  },
];
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const config = await get("/admin/maintenance/config", controller.signal);
    if (controller.signal.aborted) return;
    plan.value = { ...config };
    status.value = config;
    days.value = config.inactive_days;
    cacheDays.value = config.cache_days;
    await history.load();
  } catch (e: any) {
    if (e.name !== "AbortError") error.value = e.message;
  } finally {
    loading.value = false;
  }
}
async function previewAccounts(page = 1) {
  previewLoading.value = true;
  selection.value = [];
  const id = ++previewSequence;
  try {
    const result = await get<PageResult>(
      query("/admin/maintenance/preview", { days: days.value, page }),
      controller.signal,
    );
    if (id === previewSequence) preview.value = result;
  } catch (e: any) {
    if (e.name !== "AbortError") error.value = e.message;
  } finally {
    if (id === previewSequence) previewLoading.value = false;
  }
}
watch(days, () => {
  previewSequence++;
  preview.value = null;
  selection.value = [];
});
watch(cacheDays, () => (cache.value = null));
async function start(body: RecordData) {
  if (!can("maintenance", true)) return;
  await action.run(async () => {
    const result = await post(
      "/admin/maintenance/run",
      {
        ...body,
        confirmation: "CLEAN_SELECTED_DATA",
        request_id: crypto.randomUUID(),
      },
      controller.signal,
    );
    detail.value = result;
    await history.load();
    if (body.clean_accounts) await previewAccounts();
  }, "清理任务已提交");
}
async function cleanAccounts() {
  if (!preview.value || !selection.value.length) return;
  const ids = selection.value.map((r) => r.id),
    inactive = preview.value.inactive_days;
  if (
    !(await confirmAction(
      `将清理选中的 ${ids.length} 个超过 ${inactive} 天未上线的普通账号。执行前会重新核对保护条件；聊天、媒体和工资记录保留，账号可在“已删除”列表恢复。`,
      "清理选中账号",
    ))
  )
    return;
  await start({
    clean_accounts: true,
    clean_cache: false,
    inactive_days: inactive,
    cache_days: 7,
    user_ids: ids,
  });
}
async function previewCache() {
  await action.run(async () => {
    cache.value = await get(
      query("/admin/maintenance/cache-preview", { days: cacheDays.value }),
      controller.signal,
    );
  });
}
async function cleanCache() {
  if (
    !cache.value ||
    !(await confirmAction(
      `确认清理过期缓存，以及超过 ${cache.value.cache_days} 天的已过期登录凭据与运行日志？有效登录、设备绑定、聊天媒体和后台审计日志保留。`,
    ))
  )
    return;
  await start({
    clean_accounts: false,
    clean_cache: true,
    inactive_days: 180,
    cache_days: cache.value.cache_days,
    user_ids: [],
  });
}
async function save() {
  if (!can("maintenance", true) || !(await form.value?.validate())) return;
  if (!plan.value.clean_accounts && !plan.value.clean_cache) {
    error.value = "至少选择一种清理内容";
    return;
  }
  if (
    plan.value.enabled &&
    !(await confirmAction(
      `确认启用自动清理？每 ${plan.value.interval_days} 天于北京时间 ${plan.value.run_time} 执行。`,
    ))
  )
    return;
  await action.run(async () => {
    const saved = await post(
      "/admin/maintenance/config",
      plan.value,
      controller.signal,
    );
    plan.value = { ...saved };
    status.value = saved;
  }, "清理计划已保存");
}
async function poll() {
  if (controller.signal.aborted) return;
  try {
    const latest = await get("/admin/maintenance/config", controller.signal);
    if (controller.signal.aborted) return;
    status.value = latest;
    await history.load();
  } catch {
  } finally {
    if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
  }
}
onMounted(() => {
  void load();
  timer = setTimeout(poll, 5000);
});
onBeforeUnmount(() => {
  controller.abort();
  clearTimeout(timer);
  previewSequence++;
});
</script>
<template>
  <PageHeader title="数据清理"
    ><el-button :loading="loading" @click="load"
      >重新加载</el-button
    ></PageHeader
  ><el-alert
    v-if="error"
    :title="error"
    type="error"
    class="mb-5"
    @close="error = ''"
  />
  <section class="art-card section-card">
    <div class="section-heading">
      <div>
        <h2>长期未上线账号</h2>
        <p>仅针对符合保护条件的普通账号，执行时再次校验</p>
      </div>
    </div>
    <form class="filters" @submit.prevent="previewAccounts()">
      <label
        >未上线天数<el-input-number
          v-model="days"
          :min="1"
          :max="3650" /></label
      ><el-button type="primary" native-type="submit" :loading="previewLoading"
        >预览账号</el-button
      ><el-button
        v-if="can('maintenance', true)"
        type="danger"
        plain
        :disabled="!selection.length || action.busy.value"
        @click="cleanAccounts"
        >清理选中（{{ selection.length }}）</el-button
      >
    </form>
    <p class="soft-note">
      清理后账号不能登录，可从用户管理的“已删除”列表恢复。聊天记录、图片、作业与工资记录保留。
    </p>
    <template v-if="preview"
      ><ArtTable
        :rows="preview.items"
        :columns="candidateColumns"
        :selection="can('maintenance', true)"
        :loading="previewLoading"
        @selection-change="selection = $event" /><TablePagination
        :total="preview.total"
        :page="preview.page"
        :size="preview.size"
        @change="(p) => previewAccounts(p)" /></template
    ><el-empty
      v-else
      description="选择天数后预览符合条件的账号"
      :image-size="70"
    />
  </section>
  <div class="config-grid">
    <section class="art-card section-card">
      <div class="section-heading">
        <div>
          <h2>缓存与过期数据</h2>
          <p>有效登录和业务记录继续保留</p>
        </div>
        <ArtIcon name="Coin" :size="22" />
      </div>
      <form class="filters" @submit.prevent="previewCache">
        <label
          >凭据与日志保留天数<el-input-number
            v-model="cacheDays"
            :min="7"
            :max="365" /></label
        ><el-button native-type="submit" :loading="action.busy.value"
          >扫描可清理数据</el-button
        >
      </form>
      <template v-if="cache"
        ><dl class="cache-counts">
          <div
            v-for="(label, key) in {
              auth_tokens: '过期用户登录凭据',
              admin_sessions: '过期后台登录凭据',
              login_events: '过期登录事件',
              login_audit: '过期登录审计',
              client_diagnostics: '过期诊断',
              notifications: '已读通知',
              incomplete_uploads: '过期临时上传',
            }"
            :key="key"
          >
            <dt>{{ label }}</dt>
            <dd>{{ cache.database_rows?.[key] || 0 }} 条</dd>
          </div>
          <div>
            <dt>过期文件</dt>
            <dd>
              {{ cache.files?.files || 0 }} 个 /
              {{ ((cache.files?.bytes || 0) / 1024 / 1024).toFixed(1) }} MB
            </dd>
          </div>
        </dl>
        <p
          v-if="cache.database_limited || cache.files?.scan_limited"
          class="field-help"
        >
          预览达到扫描限额，清理会分批进行。
        </p>
        <el-button
          v-if="can('maintenance', true)"
          type="primary"
          :loading="action.busy.value"
          @click="cleanCache"
          >清理过期缓存</el-button
        ></template
      ><el-empty v-else description="扫描后查看可清理数量" :image-size="60" />
    </section>
    <section v-loading="loading" class="art-card section-card">
      <div class="section-heading">
        <div>
          <h2>定时清理</h2>
          <p>关闭页面后服务端仍按计划执行</p>
        </div>
        <el-tag :type="status.worker_online ? 'success' : 'warning'" round>{{
          status.worker_online ? "定时服务运行中" : "定时服务待确认"
        }}</el-tag>
      </div>
      <SchemaForm
        ref="form"
        v-model="plan"
        :fields="fields"
        :disabled="!can('maintenance', true) || action.busy.value"
      />
      <p class="field-help">
        {{
          status.enabled
            ? `下次执行：${status.next_run_at || "待安排"}（北京时间）`
            : "自动清理已关闭，仍可手动预览和清理。"
        }}
      </p>
      <div class="action-footer">
        <el-button
          v-if="can('maintenance', true)"
          type="primary"
          :loading="action.busy.value"
          @click="save"
          >保存清理计划</el-button
        >
      </div>
    </section>
  </div>
  <section class="art-card section-card">
    <div class="section-heading">
      <div>
        <h2>执行记录</h2>
      </div>
      <el-button text circle aria-label="刷新执行记录" @click="history.load()"
        ><ArtIcon name="Refresh" :size="17"
      /></el-button>
    </div>
    <ArtTable
      :rows="history.data.value.items"
      :columns="historyColumns"
      :loading="history.loading.value"
      :error="history.error.value"
      :action-width="80"
      @retry="history.load()"
      ><template #actions="{ row }"
        ><el-button
          link
          type="primary"
          @click="
            action.run(async () => {
              detail = await get(
                query('/admin/maintenance/run', { id: row.id }),
                controller.signal,
              );
            })
          "
          >详情</el-button
        ></template
      ></ArtTable
    ><TablePagination
      :total="history.data.value.total"
      :page="history.page.value"
      :size="history.pageSize.value"
      :has-more="history.data.value.has_more"
      :loading="history.loading.value"
      @change="
        (p) => {
          history.page.value = p;
          history.load();
        }
      "
    />
  </section>
  <el-drawer
    :model-value="!!detail"
    title="清理执行详情"
    size="740px"
    @close="detail = null"
    ><RecordDetail
      v-if="detail"
      :record="detail"
      :labels="{
        id: '任务编号',
        status: '状态',
        deleted_count: '清理账号',
        skipped_count: '跳过账号',
        users: '账号执行明细',
        cleanup_items: '清理数据项',
        error_code: '错误原因',
        created_at: '创建时间',
        finished_at: '完成时间',
      }"
  /></el-drawer>
</template>
<style scoped>
.cache-counts {
  margin: 0 0 22px;
}
.cache-counts > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 0;
  border-bottom: 1px solid var(--hairline);
  font-size: 12px;
}
.cache-counts dt {
  color: var(--muted);
}
.cache-counts dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
