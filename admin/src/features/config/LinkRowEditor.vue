<script setup lang="ts">
import ArtIcon from "../../components/ArtIcon.vue";
const props = defineProps<{
  row: { name: string; url: string };
  index: number;
  total: number;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  update: [index: number, row: { name: string; url: string }];
  remove: [index: number];
  move: [index: number, offset: number];
}>();
function updateName(value: string) {
  emit("update", props.index, { ...props.row, name: value });
}
function updateURL(value: string) {
  emit("update", props.index, { ...props.row, url: value });
}
</script>
<template>
  <div class="link-row">
    <span class="link-order">{{ String(index + 1).padStart(2, "0") }}</span>
    <el-input
      :model-value="row.name"
      placeholder="入口名称"
      maxlength="32"
      :disabled="disabled"
      @update:model-value="updateName"
    />
    <el-input
      :model-value="row.url"
      placeholder="https://example.com"
      maxlength="2048"
      :disabled="disabled"
      @update:model-value="updateURL"
    />
    <div v-if="!disabled" class="link-row-actions">
      <el-button
        text
        circle
        aria-label="上移入口"
        :disabled="index === 0"
        @click="emit('move', index, -1)"
        ><ArtIcon name="Top" :size="14"
      /></el-button>
      <el-button
        text
        circle
        aria-label="下移入口"
        :disabled="index === total - 1"
        @click="emit('move', index, 1)"
        ><ArtIcon name="Bottom" :size="14"
      /></el-button>
      <el-button
        text
        circle
        aria-label="移除入口"
        @click="emit('remove', index)"
        ><ArtIcon name="Delete" :size="16"
      /></el-button>
    </div>
  </div>
</template>
<style scoped>
.link-row {
  display: grid;
  grid-template-columns: 22px minmax(120px, 1fr) minmax(180px, 2fr) 105px;
  gap: 12px;
  align-items: center;
  margin: 15px 0;
}
.link-order {
  font-size: 11px;
  color: var(--muted);
}
.link-row-actions {
  display: flex;
  gap: 1px;
}
@media (max-width: 650px) {
  .link-row {
    grid-template-columns: 20px 1fr 30px;
  }
  .link-row > .el-input:nth-of-type(2) {
    grid-column: 2/3;
    grid-row: 2;
  }
  .link-row-actions { grid-column: 2 / 4; grid-row: 3; justify-content:flex-end; }
}
</style>
