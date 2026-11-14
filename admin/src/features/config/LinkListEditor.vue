<script setup lang="ts">
import ArtIcon from "../../components/ArtIcon.vue";
import LinkRowEditor from "./LinkRowEditor.vue";
const props = defineProps<{
  modelValue: { name: string; url: string }[];
  disabled?: boolean;
  title: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: { name: string; url: string }[]];
}>();
function updateRow(index: number, row: { name: string; url: string }) {
  emit(
    "update:modelValue",
    props.modelValue.map((value, i) => (i === index ? row : value)),
  );
}
function removeRow(index: number) {
  emit(
    "update:modelValue",
    props.modelValue.filter((_, i) => i !== index),
  );
}
function moveRow(index: number, offset: number) {
  const next = index + offset;
  if (next < 0 || next >= props.modelValue.length) return;
  const rows = [...props.modelValue];
  [rows[index], rows[next]] = [rows[next], rows[index]];
  emit("update:modelValue", rows);
}
</script>
<!-- Each reorder emits a new array; form state remains owned by the page. -->
<template>
  <div class="section-heading">
    <div>
      <h3>{{ title }}</h3>
    </div>
    <el-button
      v-if="!disabled"
      :disabled="modelValue.length >= 10"
      @click="emit('update:modelValue', [...modelValue, { name: '', url: '' }])"
      ><ArtIcon name="Plus" :size="14" />添加入口</el-button
    >
  </div>
  <LinkRowEditor
    v-for="(row, index) in modelValue"
    :key="index"
    :row="row"
    :index="index"
    :total="modelValue.length"
    :disabled="disabled"
    @update="updateRow"
    @remove="removeRow"
    @move="moveRow"
  />
  <el-empty
    v-if="!modelValue.length"
    description="尚未配置入口"
    :image-size="65"
  />
</template>
