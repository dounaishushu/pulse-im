<script setup lang="ts">
import { reactive, onMounted } from "vue";
import { can } from "../stores/session";
import { post } from "../api/client";
import { usePageData } from "../composables/usePageData";
import { useAction, confirmAction } from "../composables/useAction";
import { platforms, formatTime } from "../domain/catalog";
import type { TableColumn, RecordData } from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import ArtTable from "../components/ArtTable.vue";
import TablePagination from "../components/TablePagination.vue";
const { data, loading, error, page, pageSize, load } = usePageData(
  "/admin/mobile-devices",
);
const filters = reactive({ q: "" }),
  action = useAction();
const columns: TableColumn[] = [
  { key: "username", label: "账号", minWidth: 140 },
  { key: "nickname", label: "昵称", minWidth: 140 },
  { key: "public_id", label: "用户 ID", minWidth: 220 },
  { key: "device_id", label: "设备标识", minWidth: 240 },
  { key: "device_name", label: "设备型号", minWidth: 170 },
  {
    key: "platform",
    label: "客户端",
    width: 110,
    format: (r) => platforms[r.platform] || r.platform,
  },
  {
    key: "bound_at",
    label: "绑定时间",
    minWidth: 170,
    format: (r) => formatTime(r.bound_at),
  },
  {
    key: "last_login_at",
    label: "最近登录",
    minWidth: 170,
    format: (r) => formatTime(r.last_login_at),
  },
];
function reload(reset = false) {
  return load(filters, reset);
}
async function unbind(row?: RecordData) {
  if (
    !can("devices", true) ||
    !(await confirmAction(
      row
        ? `确认解除 ${row.username} 的手机绑定？下次登录将重新绑定。`
        : "确认解除全部手机绑定？此操作不影响当前登录，下次登录将重新绑定。",
    ))
  )
    return;
  await action.run(async () => {
    await post(
      row ? "/admin/mobile-devices/unbind" : "/admin/mobile-devices/unbind-all",
      { user_id: row?.user_id, request_id: crypto.randomUUID() },
    );
    await reload();
  }, "设备已解绑");
}
async function policy() {
  if (
    !can("devices", true) ||
    !(await confirmAction(
      data.value.enabled
        ? "确认停用手机设备锁？"
        : "确认启用手机设备锁？普通用户换手机需要管理员解绑，内部员工不受此限制。",
    ))
  )
    return;
  await action.run(async () => {
    await post("/admin/mobile-devices/policy", {
      enabled: !data.value.enabled,
      request_id: crypto.randomUUID(),
    });
    await reload();
  }, "设备锁策略已更新");
}
onMounted(() => reload());
</script>
<template>
  <PageHeader title="设备管理"
    ><el-button
      v-if="can('devices', true)"
      :disabled="action.busy.value"
      @click="policy"
      >{{ data.enabled ? "停用" : "启用" }}设备锁</el-button
    ><el-button
      v-if="can('devices', true)"
      type="danger"
      plain
      :disabled="!data.locked_total || action.busy.value"
      @click="unbind()"
      >解绑全部设备</el-button
    ></PageHeader
  ><el-alert
    :title="data.enabled ? '手机设备锁已启用' : '手机设备锁未启用'"
    :description="'普通用户首次登录绑定手机，内部员工不受限制；电脑端和网页端可正常使用。'"
    :type="data.enabled ? 'success' : 'info'"
    :closable="false"
    show-icon
    class="mb-6"
  />
  <section class="art-card section-card">
    <form class="filters" @submit.prevent="reload(true)">
      <label
        >用户检索<el-input
          v-model="filters.q"
          placeholder="账号、昵称、用户 ID"
          clearable /></label
      ><el-button type="primary" native-type="submit">查询</el-button
      ><el-button
        @click="
          filters.q = '';
          reload(true);
        "
        >重置</el-button
      >
    </form>
    <ArtTable
      :rows="data.items"
      :columns="columns"
      :loading="loading"
      :error="error"
      :action-width="100"
      @retry="reload()"
      ><template #actions="{ row }"
        ><el-button
          v-if="can('devices', true)"
          link
          type="danger"
          :disabled="action.busy.value"
          @click="unbind(row)"
          >解绑</el-button
        ><span v-else class="muted">仅查看</span></template
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
</template>
