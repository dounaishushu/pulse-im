<script setup lang="ts">
import {
  ref,
  shallowRef,
  reactive,
  computed,
  onMounted,
  useTemplateRef,
} from "vue";
import { ElMessage } from "element-plus";
import { get, post, query } from "../api/client";
import { can } from "../stores/session";
import { usePageData } from "../composables/usePageData";
import { useAction, confirmAction } from "../composables/useAction";
import { options, formatTime, tagStatus } from "../domain/catalog";
import type { FormField, TableColumn, RecordData } from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import ArtIcon from "../components/ArtIcon.vue";
import ArtTable from "../components/ArtTable.vue";
import SchemaForm from "../components/SchemaForm.vue";
import EntitySelect from "../components/EntitySelect.vue";
import TablePagination from "../components/TablePagination.vue";
import RecordDetail from "../components/RecordDetail.vue";
const { data, loading, error, page, pageSize, load } =
  usePageData("/admin/groups");
const filters = reactive({ q: "", group_id: "", owner: "" });
const selected = shallowRef<RecordData[]>([]),
  editor = shallowRef(false),
  draft = ref<RecordData>({}),
  detail = shallowRef<RecordData | null>(null);
const form = useTemplateRef<InstanceType<typeof SchemaForm>>("form"),
  action = useAction();
const kinds = { group: "群组", channel: "频道", customer_service: "客服" };
const columns: TableColumn[] = [
  { key: "name", label: "群组名称", minWidth: 200 },
  { key: "group_id", label: "群组 ID", minWidth: 180 },
  {
    key: "owner",
    label: "群主",
    minWidth: 160,
    format: (r) => r.owner_nickname || r.owner_username || String(r.owner_id),
  },
  { key: "members", label: "成员数", minWidth: 150 },
  {
    key: "type",
    label: "类型",
    width: 100,
    format: (r) => kinds[r.type as keyof typeof kinds] || r.type,
  },
  {
    key: "all_muted",
    label: "全员禁言",
    width: 110,
    format: (r) => (r.all_muted ? "已开启" : "未开启"),
  },
  {
    key: "status",
    label: "状态",
    width: 100,
    format: (r) => (r.status === "active" ? "有效" : "已停用"),
    tag: (r) => tagStatus(r.status),
  },
  {
    key: "created_at",
    label: "创建时间",
    minWidth: 170,
    format: (r) => formatTime(r.created_at),
  },
];
const fields: FormField[] = [
  { key: "name", label: "群组名称", required: true, maxLength: 128 },
  {
    key: "type",
    label: "群组类型",
    type: "select",
    required: true,
    options: options(kinds),
  },
  {
    key: "max_members",
    label: "最大成员数",
    type: "number",
    required: true,
    min: 1,
    max: 10000000,
  },
  {
    key: "display_member_count",
    label: "虚拟显示人数",
    type: "number",
    min: 0,
    max: 10000000,
    help: "0 表示恢复真实人数，之后随实际入群人数增加。",
  },
  { key: "all_muted", label: "全员禁言", type: "switch" },
  { key: "allow_member_add_friend", label: "允许成员互加好友", type: "switch" },
  {
    key: "join_method",
    label: "加群方式",
    type: "select",
    options: options({
      free: "自由加入",
      approval: "需要审核",
      invite: "仅邀请加入",
    }),
  },
  {
    key: "status",
    label: "状态",
    type: "select",
    options: options({ active: "有效", disabled: "停用" }),
  },
  { key: "description", label: "群介绍", type: "textarea", maxLength: 500 },
  { key: "announcement", label: "群公告", type: "textarea", maxLength: 10000 },
];
function reload(reset = false) {
  selected.value = [];
  return load(filters, reset);
}
const visibleFields = computed(() =>
  fields.filter(
    (field) =>
      field.key !== "display_member_count" || draft.value.type === "group",
  ),
);
async function edit(row?: RecordData) {
  if (!can("groups", true)) return;
  await action.run(async () => {
    const current = row
      ? await get(query("/admin/groups/detail", { id: row.id }))
      : {};
    draft.value = {
      name: "",
      type: "group",
      max_members: 500,
      join_method: "free",
      status: "active",
      ...current,
      all_muted: !!current.all_muted,
      allow_member_add_friend: current.allow_member_add_friend !== false,
      display_member_count: current.display_count_offset
        ? current.display_member_count
        : 0,
    };
    editor.value = true;
  });
}
async function save() {
  if (!can("groups", true) || !(await form.value?.validate())) return;
  await action.run(async () => {
    if (!draft.value.owner_id) throw new Error("请选择群主");
    if (draft.value.max_members < Number(draft.value.member_count || 1))
      throw new Error("成员上限不能小于当前人数");
    await post(
      draft.value.id ? "/admin/groups/update" : "/admin/groups/create",
      {
        ...draft.value,
        group_id: draft.value.id,
        display_member_count:
          draft.value.type === "group"
            ? Number(draft.value.display_member_count) || null
            : null,
        request_id: crypto.randomUUID(),
      },
    );
    editor.value = false;
    await reload();
  }, "群组已保存");
}
async function remove(rows: RecordData[]) {
  if (
    !can("groups", true) ||
    !rows.length ||
    !(await confirmAction(
      `确认删除 ${rows.length} 个群组？成员将移出，历史消息和账务记录保留。`,
    ))
  )
    return;
  await action.run(async () => {
    await post("/admin/groups/delete", {
      ids: rows.map((r) => r.id),
      request_id: crypto.randomUUID(),
    });
    await reload();
  }, "群组已删除");
}
function editSelected() {
  if (selected.value.length !== 1) {
    ElMessage.info("请选择一个群组进行修改");
    return;
  }
  void edit(selected.value[0]);
}
onMounted(() => reload());
</script>
<template>
  <PageHeader title="群组管理"
    ><el-button v-if="can('groups', true)" type="primary" @click="edit()"
      ><ArtIcon name="Plus" :size="15" />新增群组</el-button
    ></PageHeader
  >
  <section class="art-card section-card">
    <form class="filters" @submit.prevent="reload(true)">
      <label
        >群组检索<el-input
          v-model="filters.q"
          placeholder="名称 / 群组 ID"
          clearable /></label
      ><label
        >群主<el-input
          v-model="filters.owner"
          placeholder="群主账号或 ID"
          clearable /></label
      ><el-button type="primary" native-type="submit">查询</el-button
      ><el-button
        @click="
          filters.q = '';
          filters.owner = '';
          filters.group_id = '';
          reload(true);
        "
        >重置</el-button
      >
    </form>
    <div class="table-toolbar">
      <div v-if="can('groups', true)" class="table-toolbar-actions">
        <el-button :disabled="selected.length !== 1" @click="editSelected"
          >修改选中</el-button
        ><el-button
          type="danger"
          plain
          :disabled="!selected.length || action.busy.value"
          @click="remove(selected)"
          >删除选中</el-button
        >
      </div>
    </div>
    <ArtTable
      :rows="data.items"
      :columns="columns"
      :loading="loading"
      :error="error"
      :selection="can('groups', true)"
      :action-width="180"
      @selection-change="selected = $event"
      @retry="reload()"
      ><template #members="{ row }"
        ><strong>{{ row.display_member_count ?? row.member_count }} 人</strong>
        <p class="text-xs muted">
          实际 {{ row.member_count }} / 上限 {{ row.max_members }}
        </p></template
      ><template #actions="{ row }"
        ><el-button
          link
          type="primary"
          @click="
            action.run(async () => {
              detail = await get(query('/admin/groups/detail', { id: row.id }));
            })
          "
          >查看</el-button
        ><el-button
          v-if="can('groups', true)"
          link
          type="primary"
          @click="edit(row)"
          >编辑</el-button
        ><el-button
          v-if="can('groups', true)"
          link
          type="danger"
          @click="remove([row])"
          >删除</el-button
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
    :title="draft.id ? '编辑群组' : '新增群组'"
    size="680px"
    :close-on-click-modal="!action.busy.value"
    :close-on-press-escape="!action.busy.value"
    :show-close="!action.busy.value"
    destroy-on-close
    ><el-form label-position="top"
      ><el-form-item label="群主"
        ><EntitySelect
          v-model="draft.owner_id"
          kind="sender"
          scope="groups"
          :initial="
            draft.owner_id
              ? [
                  {
                    id: draft.owner_id,
                    name:
                      draft.owner_nickname ||
                      draft.owner_username ||
                      '#' + draft.owner_id,
                  },
                ]
              : []
          "
          :disabled="action.busy.value" /></el-form-item></el-form
    ><SchemaForm
      ref="form"
      v-model="draft"
      :fields="visibleFields"
      :disabled="action.busy.value"
    /><el-alert
      v-if="action.error.value"
      :title="action.error.value"
      type="error"
      :closable="false"
    /><template #footer
      ><el-button :disabled="action.busy.value" @click="editor = false"
        >取消</el-button
      ><el-button type="primary" :loading="action.busy.value" @click="save"
        >保存</el-button
      ></template
    ></el-drawer
  ><el-drawer
    :model-value="!!detail"
    title="群组详情"
    size="720px"
    @close="detail = null"
    ><RecordDetail
      v-if="detail"
      :record="detail"
      :labels="{
        name: '群组名称',
        group_id: '群组 ID',
        owner_id: '群主',
        type: '类型',
        description: '介绍',
        announcement: '公告',
        member_count: '实际人数',
        display_member_count: '显示人数',
        max_members: '人数上限',
        join_method: '加群方式',
        status: '状态',
        all_muted: '全员禁言',
      }"
  /></el-drawer>
</template>
