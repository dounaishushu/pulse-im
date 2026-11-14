<script setup lang="ts">
import type { RecordData } from "../../domain/types";
import ArtIcon from "../../components/ArtIcon.vue";
import ImageUpload from "../../components/ImageUpload.vue";
const props = defineProps<{
  modelValue: RecordData;
  index: number;
  total: number;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: RecordData];
  move: [offset: number];
  remove: [];
  busy: [value: boolean];
}>();
function update(key: string, value: unknown) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}
</script>
<template>
  <article class="dispatch-step">
    <div class="step-heading">
      <div>
        <span class="step-number">{{
          String(index + 1).padStart(2, "0")
        }}</span><strong>发送步骤</strong>
      </div>
      <div>
        <el-button
          text
          circle
          aria-label="上移步骤"
          :disabled="disabled || index === 0"
          @click="emit('move', -1)"
          ><ArtIcon name="Top" :size="15" /></el-button
        ><el-button
          text
          circle
          aria-label="下移步骤"
          :disabled="disabled || index === total - 1"
          @click="emit('move', 1)"
          ><ArtIcon name="Bottom" :size="15" /></el-button
        ><el-button
          text
          circle
          aria-label="删除步骤"
          :disabled="disabled || total <= 1"
          @click="emit('remove')"
          ><ArtIcon name="Delete" :size="15"
        /></el-button>
      </div>
    </div>
    <el-form label-position="top" :disabled="disabled"
      ><div class="step-settings">
        <el-form-item label="发送类型"
          ><el-select
            :model-value="modelValue.type"
            @update:model-value="update('type', $event)"
            ><el-option value="text" label="文字" /><el-option
              value="image"
              label="图片" /><el-option
              value="text_image"
              label="文字与图片" /></el-select></el-form-item
        ><el-form-item label="延迟（秒）"
          ><el-input-number
            :model-value="modelValue.delay_seconds"
            :min="0"
            :max="86400"
            controls-position="right"
            @update:model-value="update('delay_seconds', $event)"
        /></el-form-item>
      </div>
      <el-form-item v-if="modelValue.type !== 'image'" label="文字内容"
        ><el-input
          :model-value="modelValue.text"
          type="textarea"
          :rows="3"
          maxlength="2000"
          show-word-limit
          @update:model-value="update('text', $event)" /></el-form-item
      ><el-form-item v-if="modelValue.type !== 'text'" label="发送图片"
        ><ImageUpload
          :model-value="modelValue.image_url"
          path="/admin/dispatch-tasks/upload"
          :max-m-b="10"
          :disabled="disabled"
          @update:model-value="update('image_url', $event)"
          @busy="emit('busy', $event)" /></el-form-item
    ></el-form>
  </article>
</template>
<style scoped>
.dispatch-step {
  padding: 18px 21px;
  border: 1px solid var(--hairline);
  border-radius: 10px;
  margin-bottom: 17px;
}
.step-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.step-heading > div {
  display: flex;
  align-items: center;
  gap: 9px;
}
.step-number {
  color: var(--main-color);
  font-size: 12px;
  background: var(--el-color-primary-light-9);
  padding: 3px 8px;
  border-radius: 5px;
}
.step-heading strong {
  font-size: 13px;
  font-weight: 500;
}
.step-settings {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
.step-settings .el-input-number {
  width: 100%;
}
.dispatch-step :deep(.el-form-item) {
  margin-bottom: 16px;
}
.dispatch-step :deep(.el-form-item:last-child) {
  margin-bottom: 0;
}
</style>
