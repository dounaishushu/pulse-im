<script setup lang="ts">
import { computed, shallowRef, reactive, onMounted, useTemplateRef } from "vue";
import { can } from "../stores/session";
import { post } from "../api/client";
import { usePageData } from "../composables/usePageData";
import { useAction, confirmAction } from "../composables/useAction";
import type { FormField, RecordData, TableColumn } from "../domain/types";
import PageHeader from "./PageHeader.vue";
import ArtIcon from "./ArtIcon.vue";
import ArtTable from "./ArtTable.vue";
import TablePagination from "./TablePagination.vue";
import SchemaForm from "./SchemaForm.vue";

export interface CrudDefinition {
  key: string;
  title: string;
  endpoint: string;
  saveEndpoint?: string;
  deleteEndpoint?: string;
  deleteMessage?: string;
  fields: FormField[] | ((row: RecordData) => FormField[]);
  columns: TableColumn[];
  filters?: FormField[];
  defaults?: RecordData;
  prepare?: (row: RecordData) => RecordData;
  payload?: (row: RecordData) => RecordData;
  validate?: (row: RecordData) => void;
}
const props = defineProps<{ definition: CrudDefinition }>();
const table = usePageData(props.definition.endpoint);
const { data, loading, error, page, pageSize, load } = table;
const selected = shallowRef<RecordData[]>([]);
const filters = reactive<RecordData>({});
const editor = shallowRef(false),
  draft = shallowRef<RecordData>({}),
  uploading = shallowRef(false);
const form = useTemplateRef<InstanceType<typeof SchemaForm>>("form");
const action = useAction();
const manage = computed(() => can(props.definition.key, true));
const fields = computed(() =>
  typeof props.definition.fields === "function"
    ? props.definition.fields(draft.value)
    : props.definition.fields,
);
function reload() {
  selected.value = [];
  return load({ ...filters });
}
function search() {
  page.value = 1;
  return reload();
}
function reset() {
  for (const key of Object.keys(filters)) delete filters[key];
  return search();
}
function edit(row?: RecordData) {
  if (!manage.value) return;
  const value = {
    ...(props.definition.defaults || {}),
    ...JSON.parse(JSON.stringify(row || {})),
  };
  draft.value = props.definition.prepare
    ? props.definition.prepare(value)
    : value;
  editor.value = true;
}
async function save() {
  if (!manage.value || uploading.value || !(await form.value?.validate()))
    return;
  await action.run(async () => {
    props.definition.validate?.(draft.value);
    const payload = props.definition.payload
      ? props.definition.payload(draft.value)
      : draft.value;
    await post(props.definition.saveEndpoint || props.definition.endpoint, {
      ...payload,
      request_id: crypto.randomUUID(),
    });
    editor.value = false;
    await reload();
  }, "保存成功");
}
async function remove(rows: RecordData[]) {
  if (!manage.value || !rows.length || !props.definition.deleteEndpoint) return;
  if (
    !(await confirmAction(
      props.definition.deleteMessage ||
        `确认删除选中的 ${rows.length} 条记录？`,
    ))
  )
    return;
  await action.run(async () => {
    await post(props.definition.deleteEndpoint!, {
      ids: rows.map((r) => r.id),
      request_id: crypto.randomUUID(),
    });
    await reload();
  }, "删除完成");
}
onMounted(reload);
defineExpose({ edit, reload, selected, data, filters, draft });
</script>
<template>
  <PageHeader :title="definition.title"
    ><slot name="header" :reload="reload" /><el-button
      v-if="manage"
      type="primary"
      @click="edit()"
      ><ArtIcon name="Plus" :size="15" />新增</el-button
    ></PageHeader
  >
  <section class="art-card section-card">
    <form class="filters" @submit.prevent="search">
      <label v-for="field in definition.filters" :key="field.key"
        >{{ field.label
        }}<el-select
          v-if="field.type === 'select'"
          v-model="filters[field.key]"
          clearable
          placeholder="全部"
          ><el-option
            v-for="option in field.options"
            :key="String(option.value)"
            :label="option.label"
            :value="option.value" /></el-select
        ><el-input
          v-else
          v-model="filters[field.key]"
          :placeholder="`搜索${field.label}`"
          clearable
          :maxlength="field.maxLength || 128"
      /></label>
      <div v-if="definition.filters?.length" class="filter-actions">
        <el-button type="primary" native-type="submit"
          ><ArtIcon name="Search" :size="14" />查询</el-button
        ><el-button @click="reset">重置</el-button>
      </div>
    </form>
    <div class="table-toolbar">
      <div class="table-toolbar-actions">
        <slot name="toolbar" :reload="reload" :filters="filters" /><el-button
          v-if="definition.deleteEndpoint && manage"
          :disabled="!selected.length || action.busy.value"
          type="danger"
          plain
          @click="remove(selected)"
          >删除选中<template v-if="selected.length"
            >（{{ selected.length }}）</template
          ></el-button
        ><el-button text circle aria-label="刷新列表" @click="reload"
          ><ArtIcon name="Refresh" :size="16"
        /></el-button>
      </div>
    </div>
    <ArtTable
      :rows="data.items"
      :columns="definition.columns"
      :loading="loading"
      :error="error"
      :selection="!!definition.deleteEndpoint && manage"
      :action-width="230"
      @selection-change="selected = $event"
      @retry="reload"
    >
      <template v-for="(_, slotName) in $slots" #[slotName]="slotProps"
        ><slot :name="slotName" v-bind="slotProps"
      /></template>
      <template #actions="{ row }"
        ><slot name="row-actions" :row="row" :reload="reload" /><el-button
          v-if="manage"
          link
          type="primary"
          :disabled="action.busy.value"
          @click="edit(row)"
          >编辑</el-button
        ><el-button
          v-if="definition.deleteEndpoint && manage"
          link
          type="danger"
          :disabled="action.busy.value"
          @click="remove([row])"
          >删除</el-button
        ><span v-if="!manage" class="muted">仅查看</span></template
      >
    </ArtTable>
    <TablePagination
      :total="data.total"
      :page="page"
      :size="pageSize"
      :loading="loading"
      :has-more="data.has_more"
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
    :title="`${draft.id ? '编辑' : '新增'}${definition.title.replace('管理', '')}`"
    size="640px"
    :close-on-click-modal="!action.busy.value && !uploading"
    :close-on-press-escape="!action.busy.value && !uploading"
    :show-close="!action.busy.value && !uploading"
    destroy-on-close
    @closed="draft = {}"
  >
    <SchemaForm
      ref="form"
      v-model="draft"
      :fields="fields"
      :disabled="action.busy.value || !manage"
      @busy="uploading = $event"
    /><slot name="editor-extra" :draft="draft" /><el-alert
      v-if="action.error.value"
      :title="action.error.value"
      type="error"
      :closable="false"
      show-icon
    />
    <template #footer
      ><el-button
        :disabled="action.busy.value || uploading"
        @click="editor = false"
        >取消</el-button
      ><el-button
        type="primary"
        :loading="action.busy.value"
        :disabled="uploading || !manage"
        @click="save"
        >保存</el-button
      ></template
    >
  </el-drawer>
</template>
