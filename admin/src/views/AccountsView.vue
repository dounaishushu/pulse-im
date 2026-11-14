<script setup lang="ts">
import {
  ref,
  shallowRef,
  computed,
  reactive,
  onMounted,
  useTemplateRef,
} from "vue";
import { ElMessage } from "element-plus";
import { post } from "../api/client";
import { useSession } from "../stores/session";
import { usePageData } from "../composables/usePageData";
import { useAction, confirmAction } from "../composables/useAction";
import { pages, roles, options } from "../domain/catalog";
import type { FormField, TableColumn, RecordData } from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import ArtIcon from "../components/ArtIcon.vue";
import ArtTable from "../components/ArtTable.vue";
import SchemaForm from "../components/SchemaForm.vue";
import TablePagination from "../components/TablePagination.vue";
const session = useSession(),
  { data, loading, error, page, pageSize, load } =
    usePageData("/admin/accounts"),
  action = useAction();
const filters = reactive({ q: "", status: "" }),
  editor = shallowRef(false),
  draft = ref<RecordData>({}),
  entry = shallowRef("");
const form = useTemplateRef<InstanceType<typeof SchemaForm>>("form");
const catalog = pages.filter((p) => p.key !== "admin-accounts");
const fields = computed<FormField[]>(() => [
  {
    key: "username",
    label: "管理员账号",
    required: true,
    disabled: !!draft.value.id,
    maxLength: 64,
    help: "3—64 位，以字母开头，可含数字、点、横线或下划线。",
  },
  {
    key: "role",
    label: "角色",
    type: "select",
    required: true,
    options: options(roles),
    disabled: draft.value.id === session.account.value?.id,
  },
  {
    key: "password",
    label: draft.value.id ? "重置密码" : "初始密码",
    type: "password",
    required: !draft.value.id,
    wide: true,
    help: "14—128 位，编辑时留空保持原密码。",
  },
  {
    key: "status",
    label: "状态",
    type: "select",
    options: options({ active: "启用", disabled: "停用" }),
    disabled: draft.value.id === session.account.value?.id,
  },
]);
const columns: TableColumn[] = [
  { key: "username", label: "账号", minWidth: 180 },
  {
    key: "role",
    label: "角色",
    minWidth: 160,
    format: (r) => roles[r.role as keyof typeof roles] || r.role,
  },
  {
    key: "permissions",
    label: "页面权限",
    minWidth: 260,
    format: (r) =>
      r.role === "admin"
        ? "全部权限"
        : r.permissions?.length
          ? catalog
              .filter((p) => r.permissions.includes(p.key + ".view"))
              .map((p) => p.title)
              .join("、")
          : "未分配权限",
  },
  {
    key: "status",
    label: "状态",
    width: 100,
    format: (r) => (r.status === "active" ? "启用" : "停用"),
    tag: (r) => (r.status === "active" ? "success" : "info"),
  },
  { key: "created_at", label: "创建时间", minWidth: 175 },
  { key: "updated_at", label: "更新时间", minWidth: 175 },
];
function reload(reset = false) {
  return load(filters, reset);
}
function edit(row?: RecordData) {
  draft.value = {
    username: "",
    role: "operator",
    status: "active",
    permissions: [],
    ...JSON.parse(JSON.stringify(row || {})),
    password: "",
  };
  action.error.value = "";
  editor.value = true;
}
function permission(key: string, mode: "view" | "manage", enabled: boolean) {
  const values = new Set<string>(draft.value.permissions || []);
  if (enabled) {
    values.add(key + ".view");
    if (mode === "manage") values.add(key + ".manage");
  } else {
    values.delete(key + "." + mode);
    if (mode === "view") values.delete(key + ".manage");
  }
  draft.value = { ...draft.value, permissions: [...values] };
}
function preset(mode: "all" | "view" | "none") {
  draft.value = {
    ...draft.value,
    permissions:
      mode === "none"
        ? []
        : catalog.flatMap((p) => [
            p.key + ".view",
            ...(mode === "all" && p.manage && draft.value.role !== "auditor"
              ? [p.key + ".manage"]
              : []),
          ]),
  };
}
async function save() {
  if (!session.isSuper.value || !(await form.value?.validate())) return;
  await action.run(async () => {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{2,63}$/.test(draft.value.username))
      throw new Error("管理员账号格式不正确");
    const password = String(draft.value.password || "");
    if (
      (!draft.value.id || password) &&
      (password.length < 14 || password.length > 128)
    )
      throw new Error("管理员密码需要 14—128 位");
    let permissions: string[] = draft.value.permissions || [];
    if (draft.value.role === "admin") permissions = [];
    if (draft.value.role === "auditor")
      permissions = permissions.filter((p) => p.endsWith(".view"));
    const result = await post(
      draft.value.id ? "/admin/accounts/update" : "/admin/accounts",
      { ...draft.value, permissions },
    );
    draft.value.password = "";
    editor.value = false;
    if (result.entry_token)
      entry.value = new URL(
        "/entry/#" + result.entry_token,
        location.origin,
      ).href;
    await reload();
    if (draft.value.id === session.account.value?.id) await session.refresh();
  }, "后台账号已保存");
}
async function toggle(row: RecordData) {
  if (
    !session.isSuper.value ||
    !(await confirmAction(
      `确认${row.status === "active" ? "停用" : "启用"}管理员 ${row.username}？修改后旧会话会撤销。`,
    ))
  )
    return;
  await action.run(async () => {
    await post("/admin/accounts/status", {
      id: row.id,
      status: row.status === "active" ? "disabled" : "active",
    });
    await reload();
  }, "状态已更新");
}
async function copyEntry() {
  try {
    await navigator.clipboard.writeText(entry.value);
    ElMessage.success("已复制专属入口");
  } catch {
    ElMessage.info("浏览器未允许复制，请手动选择并保存入口");
  }
}
onMounted(() => reload());
</script>
<template>
  <PageHeader title="后台账号"
    ><el-button v-if="session.isSuper.value" type="primary" @click="edit()"
      ><ArtIcon name="Plus" :size="15" />新增后台账号</el-button
    ></PageHeader
  >
  <section class="art-card section-card">
    <form class="filters" @submit.prevent="reload(true)">
      <label
        >管理员账号<el-input
          v-model="filters.q"
          placeholder="搜索账号"
          clearable /></label
      ><label
        >状态<el-select v-model="filters.status" clearable placeholder="全部"
          ><el-option label="启用" value="active" /><el-option
            label="停用"
            value="disabled" /></el-select></label
      ><el-button type="primary" native-type="submit">查询</el-button
      ><el-button
        @click="
          filters.q = '';
          filters.status = '';
          reload(true);
        "
        >重置</el-button
      >
    </form>
    <p class="soft-note">
      后台账号与普通用户账号独立。角色和权限变更后，旧登录会话将失效；不能降级或停用当前登录账号。
    </p>
    <ArtTable
      :rows="data.items"
      :columns="columns"
      :loading="loading"
      :error="error"
      :action-width="160"
      @retry="reload()"
      ><template #actions="{ row }"
        ><el-button link type="primary" @click="edit(row)">编辑</el-button
        ><el-button
          v-if="row.id !== session.account.value?.id"
          link
          :type="row.status === 'active' ? 'danger' : 'success'"
          :disabled="action.busy.value"
          @click="toggle(row)"
          >{{ row.status === "active" ? "停用" : "启用" }}</el-button
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
  <el-drawer
    v-model="editor"
    :title="draft.id ? '编辑后台账号' : '新增后台账号'"
    size="740px"
    :close-on-click-modal="!action.busy.value"
    :close-on-press-escape="!action.busy.value"
    :show-close="!action.busy.value"
    destroy-on-close
    @closed="draft = {}"
    ><SchemaForm
      ref="form"
      v-model="draft"
      :fields="fields"
      :disabled="action.busy.value"
    /><template v-if="draft.role !== 'admin'"
      ><div class="section-heading mt-5">
        <h3>页面权限</h3>
        <div>
          <el-button link type="primary" @click="preset('view')"
            >全部只读</el-button
          ><el-button link type="primary" @click="preset('all')">全选</el-button
          ><el-button link @click="preset('none')">清空</el-button>
        </div>
      </div>
      <div class="permission-header">
        <span>业务页面</span><span>查看</span><span>管理</span>
      </div>
      <div v-for="item in catalog" :key="item.key" class="permission-row">
        <span>{{ item.title }}</span><el-checkbox
          :model-value="draft.permissions?.includes(item.key + '.view')"
          :aria-label="`${item.title}查看权限`"
          :disabled="action.busy.value"
          @change="permission(item.key, 'view', !!$event)"
        /><el-checkbox
          v-if="item.manage"
          :model-value="
            draft.role !== 'auditor' &&
            draft.permissions?.includes(item.key + '.manage')
          "
          :aria-label="`${item.title}管理权限`"
          :disabled="draft.role === 'auditor' || action.busy.value"
          @change="permission(item.key, 'manage', !!$event)"
        /><span v-else>—</span>
      </div>
      <p class="field-help">
        消息与会话 / 内容审核共享服务端消息权限；客户端配置 /
        线路管理共享配置权限。
      </p></template
    ><el-alert
      v-else
      title="超级管理员拥有全部页面与管理权限"
      type="info"
      :closable="false"
    /><el-alert
      v-if="action.error.value"
      :title="action.error.value"
      type="error"
      :closable="false"
      class="mt-4"
    /><template #footer
      ><el-button :disabled="action.busy.value" @click="editor = false"
        >取消</el-button
      ><el-button type="primary" :loading="action.busy.value" @click="save"
        >保存</el-button
      ></template
    ></el-drawer
  ><el-dialog
    :model-value="!!entry"
    title="保存专属入口"
    width="600px"
    :close-on-click-modal="false"
    @close="entry = ''"
    ><p class="soft-note">
      专属入口仅在本次创建成功后显示，请现在保存并交给对应管理员。
    </p>
    <el-input
      :model-value="entry"
      type="textarea"
      :rows="4"
      readonly
    /><template #footer
      ><el-button @click="entry = ''">已保存</el-button
      ><el-button type="primary" @click="copyEntry"
        >复制入口</el-button
      ></template
    ></el-dialog
  >
</template>
<style scoped>
.permission-row,
.permission-header {
  display: grid;
  grid-template-columns: 1fr 75px 75px;
  align-items: center;
  gap: 12px;
  padding: 9px 13px;
  border-bottom: 1px solid var(--hairline);
  font-size: 12px;
}
.permission-header {
  background: var(--page-bg);
  color: var(--muted);
  font-size: 11px;
  border-radius: 7px;
}
.permission-row > span:not(:first-child) {
  color: var(--muted);
}
</style>
