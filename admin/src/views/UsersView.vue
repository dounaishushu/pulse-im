<script setup lang="ts">
import { reactive, shallowRef, onMounted, onBeforeUnmount } from "vue";
import { get, post, query, mediaURL } from "../api/client";
import { can } from "../stores/session";
import { usePageData } from "../composables/usePageData";
import { useAction, confirmAction } from "../composables/useAction";
import {
  publicId,
  labelStatus,
  tagStatus,
  formatTime,
} from "../domain/catalog";
import type { RecordData, TableColumn } from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import ArtIcon from "../components/ArtIcon.vue";
import ArtTable from "../components/ArtTable.vue";
import TablePagination from "../components/TablePagination.vue";
import RecordDetail from "../components/RecordDetail.vue";
import UserEditor from "../features/users/UserEditor.vue";
import PreviewImage from "../components/PreviewImage.vue";
const { data, page, pageSize, loading, error, load } = usePageData(
  "/admin/users",
  30,
);
const filters = reactive({ q: "", status: "" });
const action = useAction(),
  editOpen = shallowRef(false),
  batch = shallowRef(false),
  editing = shallowRef<RecordData | null>(null);
const devices = shallowRef<RecordData | null>(null),
  ipLocations = shallowRef<RecordData>({});
const ipLoading = shallowRef(false),
  ipError = shallowRef("");
let ipController: AbortController | undefined,
  ipSequence = 0;
const permissions = [
  { key: "muted", label: "禁言" },
  { key: "allow_add_friend", label: "添加好友" },
  { key: "allow_create_group", label: "创建群组" },
  { key: "internal_staff", label: "内部员工" },
  { key: "formal_employee", label: "正式员工" },
  { key: "allow_view_devices", label: "设备查看" },
];
const columns: TableColumn[] = [
  { key: "profile", label: "用户", minWidth: 210 },
  { key: "member_id", label: "编号", width: 85 },
  { key: "public_id", label: "用户 ID", minWidth: 165, format: publicId },
  {
    key: "status",
    label: "状态",
    width: 90,
    format: (r) => labelStatus(r.status),
    tag: (r) => tagStatus(r.status),
  },
  {
    key: "online",
    label: "在线",
    width: 85,
    format: (r) => (r.online ? "在线" : "离线"),
  },
  ...permissions.map((p) => ({ key: p.key, label: p.label, width: 100 })),
  { key: "register_ip", label: "注册 IP / 归属地", minWidth: 190 },
  { key: "login_ip", label: "登录 IP / 归属地", minWidth: 190 },
  {
    key: "login_at",
    label: "最近登录",
    minWidth: 170,
    format: (r) => formatTime(r.login_at),
  },
  {
    key: "registered_at",
    label: "注册时间",
    minWidth: 170,
    format: (r) => formatTime(r.registered_at),
  },
];
async function reload(reset = false) {
  await load(filters, reset);
  if (!error.value) await loadLocations();
}
async function loadLocations() {
  ipController?.abort();
  ipController = new AbortController();
  const current = ++ipSequence;
  ipLoading.value = true;
  ipError.value = "";
  const ips = [
    ...new Set(
      data.value.items
        .flatMap((r) => [r.register_ip, r.login_ip])
        .filter(Boolean),
    ),
  ];
  if (ips.length) {
    try {
      const locations: RecordData = {};
      for (let offset = 0; offset < ips.length; offset += 20) {
        const result = await get(
          "/admin/users/ip-locations?" +
            new URLSearchParams(
              ips.slice(offset, offset + 20).map((ip) => ["ips[]", ip]),
            ),
          ipController.signal,
        );
        if (current !== ipSequence) return;
        for (const row of result.items || []) locations[row.ip] = row.location;
      }
      ipLocations.value = locations;
    } catch (e: any) {
      if (current === ipSequence && e.name !== "AbortError")
        ipError.value = "归属地暂不可用，用户列表仍可正常操作";
    }
  }
  if (current === ipSequence) ipLoading.value = false;
}
function openEditor(user: RecordData | null = null, isBatch = false) {
  editing.value = user;
  batch.value = isBatch;
  editOpen.value = true;
}
async function setPermission(row: RecordData, field: string, value: boolean) {
  if (!can("users", true)) return;
  await action.run(async () => {
    await post("/admin/users/permission", {
      user_id: row.id,
      field,
      value,
      request_id: crypto.randomUUID(),
    });
    await reload();
  }, "权限已更新");
}
async function operate(row: RecordData, command: string) {
  if (command === "devices") {
    await action.run(async () => {
      devices.value = await get(
        query("/admin/users/devices", { user_id: row.id }),
      );
    });
    return;
  }
  if (!can("users", true)) return;
  const labels: Record<string, string> = {
    logout: "强制下线",
    "clear-chat": "清理聊天记录",
    "reset-token": "重置登录令牌",
    delete: "删除用户",
    active: "恢复用户",
    frozen: "冻结用户",
  };
  const note =
    command === "delete"
      ? "账号将软删除，聊天与工资记录保留，可恢复。"
      : command === "clear-chat"
        ? "将隐藏该用户的聊天历史，后台留存记录保留。"
        : "";
  if (
    !(await confirmAction(
      `确认对 ${row.account || row.nickname} ${labels[command]}？${note}`,
    ))
  )
    return;
  await action.run(async () => {
    await post(
      [
        "/admin/users/",
        ["active", "frozen"].includes(command) ? "status" : command,
      ].join(""),
      { user_id: row.id, status: command, request_id: crypto.randomUUID() },
    );
    await reload();
  }, "操作完成");
}
onMounted(() => reload());
onBeforeUnmount(() => {
  ipSequence++;
  ipController?.abort();
});
</script>
<template>
  <PageHeader title="用户管理"
    ><el-button v-if="can('users', true)" @click="openEditor(null, true)"
      ><ArtIcon name="Files" :size="15" />批量建号</el-button
    ><el-button v-if="can('users', true)" type="primary" @click="openEditor()"
      ><ArtIcon name="Plus" :size="15" />新增用户</el-button
    ></PageHeader
  >
  <section class="art-card section-card">
    <form class="filters" @submit.prevent="reload(true)">
      <label
        >用户检索<el-input
          v-model="filters.q"
          placeholder="账号、昵称、用户 ID"
          clearable
          maxlength="128" /></label
      ><label
        >账号状态<el-select
          v-model="filters.status"
          clearable
          placeholder="全部状态"
          ><el-option label="正常" value="active" /><el-option
            label="已冻结"
            value="frozen" /><el-option
            label="已删除"
            value="deleted" /></el-select
      ></label>
      <div class="filter-actions">
        <el-button type="primary" native-type="submit"
          ><ArtIcon name="Search" :size="14" />查询</el-button
        ><el-button
          @click="
            filters.q = '';
            filters.status = '';
            reload(true);
          "
          >重置</el-button
        >
      </div>
    </form>
    <p v-if="ipLoading" class="field-help mb-3">正在读取 IP 归属地…</p>
    <p v-else-if="ipError" class="field-help mb-3">
      {{ ipError
      }}<el-button link type="primary" @click="loadLocations">重试</el-button>
    </p>
    <div class="table-toolbar">
      <el-button text circle aria-label="刷新用户" @click="reload()"
        ><ArtIcon name="Refresh" :size="17"
      /></el-button>
    </div>
    <ArtTable
      :rows="data.items"
      :columns="columns"
      :loading="loading"
      :error="error"
      :action-width="140"
      @retry="reload()"
      ><template #profile="{ row }"
        ><div class="person-cell">
          <PreviewImage
            v-if="row.avatar_url"
            :src="mediaURL(row.avatar_url)"
            :alt="`${row.nickname || row.account}的头像`"
            :preview-src-list="[mediaURL(row.avatar_url)]"
            preview-teleported
            class="user-avatar"
            fit="cover"
          /><el-avatar v-else :size="35">{{
            (row.nickname || row.account || "用").slice(0, 1)
          }}</el-avatar>
          <div>
            <strong>{{ row.nickname }}</strong><small>{{ row.account }}</small>
          </div>
        </div></template
      ><template
        v-for="permission in permissions"
        :key="permission.key"
        #[permission.key]="{ row }"
        ><el-switch
          :model-value="!!row.permissions?.[permission.key]"
          :disabled="!can('users', true) || action.busy.value"
          size="small"
          :aria-label="`${row.account} ${permission.label}`"
          @change="setPermission(row, permission.key, !!$event)" /></template
      ><template #register_ip="{ row }"
        ><span>{{ row.register_ip || "—" }}</span>
        <p class="text-xs muted">
          {{
            ipLocations[row.register_ip] ||
            row.register_ip_location ||
            "暂未识别"
          }}
        </p></template
      ><template #login_ip="{ row }"
        ><span>{{ row.login_ip || "—" }}</span>
        <p class="text-xs muted">
          {{ ipLocations[row.login_ip] || row.login_ip_location || "暂未识别" }}
        </p></template
      ><template #actions="{ row }"
        ><el-button
          v-if="can('users', true)"
          link
          type="primary"
          @click="openEditor(row)"
          >编辑</el-button
        ><el-dropdown trigger="click" @command="operate(row, $event)"
          ><el-button link type="primary" :disabled="action.busy.value"
            >更多<ArtIcon name="ArrowDown" :size="11" /></el-button
          ><template #dropdown
            ><el-dropdown-menu
              ><el-dropdown-item command="devices">设备信息</el-dropdown-item
              ><template v-if="can('users', true)"
                ><el-dropdown-item
                  :command="row.status === 'active' ? 'frozen' : 'active'"
                  >{{
                    row.status === "active" ? "冻结用户" : "恢复用户"
                  }}</el-dropdown-item
                ><el-dropdown-item command="logout">强制下线</el-dropdown-item
                ><el-dropdown-item command="reset-token"
                  >重置登录令牌</el-dropdown-item
                ><el-dropdown-item command="clear-chat"
                  >清理聊天记录</el-dropdown-item
                ><el-dropdown-item
                  v-if="row.status !== 'deleted'"
                  command="delete"
                  divided
                  >删除用户</el-dropdown-item
                ></template
              ></el-dropdown-menu
            ></template
          ></el-dropdown
        ></template
      ></ArtTable
    >
    <TablePagination
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
  <UserEditor
    v-model="editOpen"
    :user="editing"
    :batch="batch"
    @saved="reload()"
  />
  <el-drawer
    :model-value="!!devices"
    title="用户设备信息"
    size="650px"
    @close="devices = null"
    ><el-alert
      v-if="devices?.hidden"
      title="该用户设备信息受隐私设置保护"
      type="info"
      :closable="false" /><RecordDetail
      v-else-if="devices"
      :record="devices.items || devices"
  /></el-drawer>
</template>
<style scoped>
.user-avatar {
  width: 35px;
  height: 35px;
  border-radius: 10px;
  flex-shrink: 0;
}
</style>
