<script setup lang="ts">
import { shallowRef, computed, onBeforeUnmount } from "vue";
import { get, query } from "../api/client";
import type { RecordData } from "../domain/types";
const props = withDefaults(
  defineProps<{
    modelValue: number | number[] | null;
    kind: "sender" | "user" | "group";
    scope?: "groups" | "dispatch";
    multiple?: boolean;
    disabled?: boolean;
    initial?: RecordData[];
    placeholder?: string;
  }>(),
  { initial: () => [], placeholder: "输入账号或名称搜索", scope: "dispatch" },
);
const emit = defineEmits<{ "update:modelValue": [value: any] }>();
const rows = shallowRef<RecordData[]>([]),
  loading = shallowRef(false),
  error = shallowRef("");
const options = computed(() => [
  ...new Map(
    [...props.initial, ...rows.value].map((r) => [Number(r.id), r]),
  ).values(),
]);
let timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined;
let sequence = 0;
function search(text: string) {
  clearTimeout(timer);
  controller?.abort();
  const id = ++sequence;
  timer = setTimeout(async () => {
    loading.value = true;
    error.value = "";
    controller = new AbortController();
    try {
      const result = await get(
        query("/admin/dispatch-tasks/options", {
          scope: props.scope,
          kind: props.kind,
          q: text,
        }),
        controller.signal,
      );
      if (id === sequence)
        rows.value = [
          ...new Map(
            [...rows.value, ...result.items].map((r) => [r.id, r]),
          ).values(),
        ];
    } catch (e: any) {
      if (id === sequence && e.name !== "AbortError") error.value = e.message;
    } finally {
      if (id === sequence) loading.value = false;
    }
  }, 250);
}
function visible(value: boolean) {
  if (value && !rows.value.length) search("");
}
onBeforeUnmount(() => {
  sequence++;
  clearTimeout(timer);
  controller?.abort();
});
</script>
<template>
  <div class="entity-select">
    <el-select
      :model-value="modelValue"
      :multiple="multiple"
      filterable
      remote
      :remote-method="search"
      :loading="loading"
      :disabled="disabled"
      :placeholder="placeholder"
      clearable
      :multiple-limit="100"
      collapse-tags
      collapse-tags-tooltip
      @visible-change="visible"
      @update:model-value="emit('update:modelValue', $event)"
      ><el-option
        v-for="row in options"
        :key="row.id"
        :label="`${row.name || row.nickname || row.username || '#' + row.id}${row.username ? ' · ' + row.username : ''}`"
        :value="Number(row.id)"
    /></el-select>
    <p v-if="error" class="field-help text-red-500">{{ error }}</p>
  </div>
</template>
<style scoped>
.entity-select {
  width: 100%;
}
.entity-select :deep(.el-select) {
  width: 100%;
}
</style>
