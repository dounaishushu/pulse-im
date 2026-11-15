<script setup lang="ts">
import { useSlots, useTemplateRef } from "vue";
import type { TableInstance } from "element-plus";
import type { RecordData, TableColumn } from "../domain/types";
defineProps<{
  rows: RecordData[];
  columns: TableColumn[];
  loading?: boolean;
  error?: string;
  selection?: boolean;
  selectable?: (row: RecordData) => boolean;
  actionWidth?: number;
  rowKey?: string;
}>();
defineEmits<{ selectionChange: [rows: RecordData[]]; retry: [] }>();
const slots = useSlots();
const table = useTemplateRef<TableInstance>("table");
defineExpose({ clearSelection: () => table.value?.clearSelection() });
const cell = (row: RecordData, column: TableColumn) =>
  column.format ? column.format(row) : (row[column.key] ?? "—");
</script>
<template>
  <div class="art-table">
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
      class="mb-4"
      ><el-button link type="primary" @click="$emit('retry')"
        >重新加载</el-button
      ></el-alert
    >
    <el-table
      ref="table"
      v-loading="loading"
      :data="rows"
      :row-key="rowKey || 'id'"
      style="width: 100%"
      @selection-change="$emit('selectionChange', $event)"
    >
      <el-table-column
        v-if="selection"
        type="selection"
        width="48"
        :reserve-selection="false"
        :selectable="selectable"
      />
      <el-table-column
        v-for="column in columns"
        :key="column.key"
        :prop="column.key"
        :label="column.label"
        :width="column.width"
        :min-width="column.minWidth || 120"
        show-overflow-tooltip
      >
        <template #default="{ row }">
          <slot :name="column.key" :row="row"
            ><el-tag
              v-if="column.tag"
              :type="column.tag(row)"
              effect="light"
              round
              >{{ cell(row, column) }}</el-tag
            ><span v-else>{{ cell(row, column) }}</span></slot
          >
        </template>
      </el-table-column>
      <el-table-column
        v-if="slots.actions"
        label="操作"
        :width="actionWidth || 180"
        fixed="right"
        ><template #default="{ row }"
          ><div class="table-actions">
            <slot name="actions" :row="row" /></div></template
      ></el-table-column>
      <template #empty
        ><el-empty
          :description="
            loading
              ? '正在读取数据…'
              : error
                ? '数据读取失败，请重新加载'
                : '暂无符合条件的数据'
          "
          :image-size="80"
      /></template>
    </el-table>
  </div>
</template>
