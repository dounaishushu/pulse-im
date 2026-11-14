<script setup lang="ts">
defineProps<{
  total: number;
  page: number;
  size: number;
  loading?: boolean;
  hasMore?: boolean;
}>();
defineEmits<{ change: [page: number, size: number] }>();
</script>
<template>
  <div class="table-pagination">
    <span class="muted">{{
      hasMore
        ? "后面还有更多记录"
        : `共 ${total.toLocaleString("zh-CN")} 条记录`
    }}</span>
    <el-pagination
      v-if="total > 0"
      :current-page="page"
      :page-size="size"
      :total="total"
      :page-sizes="[10, 20, 30, 50, 100]"
      layout="sizes, prev, pager, next, jumper"
      :disabled="loading"
      @current-change="$emit('change', $event, size)"
      @size-change="$emit('change', 1, $event)"
    />
  </div>
</template>
