<script setup lang="ts">
import type { RecordData } from "../domain/types";
defineProps<{ record: RecordData; labels?: Record<string, string> }>();
function display(value: unknown) {
  return value === null || value === undefined || value === ""
    ? "—"
    : typeof value === "object"
      ? JSON.stringify(value, null, 2)
      : String(value);
}
</script>
<template>
  <el-descriptions :column="2" border
    ><el-descriptions-item
      v-for="(value, key) in record"
      :key="key"
      :label="labels?.[key] || String(key)"
    >
      <pre class="detail-value">{{ display(value) }}</pre>
    </el-descriptions-item></el-descriptions
  >
</template>
