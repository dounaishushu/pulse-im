<script setup lang="ts">
import { shallowRef, onBeforeUnmount, useTemplateRef } from "vue";
import { ElMessage } from "element-plus";
import { upload, mediaURL } from "../api/client";
import ArtIcon from "./ArtIcon.vue";
const props = withDefaults(
  defineProps<{
    path: string;
    modelValue: string;
    disabled?: boolean;
    maxMB?: number;
    avatar?: boolean;
  }>(),
  { maxMB: 10 },
);
const emit = defineEmits<{
  "update:modelValue": [value: string];
  busy: [value: boolean];
}>();
const busy = shallowRef(false);
const controller = new AbortController();
const input = useTemplateRef<HTMLInputElement>("fileInput");
function choose() {
  if (!props.disabled && !busy.value) input.value?.click();
}
onBeforeUnmount(() => controller.abort());
async function changed(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file || busy.value || props.disabled) return;
  if (
    !(
      props.avatar
        ? ["image/png", "image/jpeg"]
        : ["image/png", "image/jpeg", "image/webp", "image/gif"]
    ).includes(file.type) ||
    file.size > props.maxMB * 1024 * 1024
  ) {
    ElMessage.error(
      `请选择 ${props.maxMB}MB 以内的 ${props.avatar ? "PNG 或 JPEG" : "PNG、JPEG、WebP 或 GIF"} 图片`,
    );
    return;
  }
  busy.value = true;
  emit("busy", true);
  try {
    const result = await upload(props.path, file, controller.signal);
    emit("update:modelValue", result.url);
  } catch (error: any) {
    if (error.name !== "AbortError") ElMessage.error(error.message);
  } finally {
    busy.value = false;
    emit("busy", false);
  }
}
</script>
<template>
  <div class="image-upload">
    <el-image
      v-if="mediaURL(modelValue)"
      :src="mediaURL(modelValue)"
      :preview-src-list="[mediaURL(modelValue)]"
      preview-teleported
      fit="cover"
      class="upload-preview"
    />
    <label
      class="upload-trigger"
      :class="{ disabled: disabled || busy }"
      role="button"
      :tabindex="disabled || busy ? -1 : 0"
      :aria-disabled="disabled || busy"
      @keydown.enter.prevent="choose"
      @keydown.space.prevent="choose"
    >
      <ArtIcon :name="busy ? 'Loading' : 'Upload'" /><span>{{
        busy ? "正在处理…" : modelValue ? "更换图片" : "上传图片"
      }}</span>
      <input
        ref="fileInput"
        type="file"
        :accept="
          avatar
            ? 'image/png,image/jpeg'
            : 'image/png,image/jpeg,image/webp,image/gif'
        "
        :disabled="disabled || busy"
        @change="changed"
      />
    </label>
    <el-button
      v-if="modelValue"
      link
      type="danger"
      :disabled="disabled || busy"
      @click="emit('update:modelValue', '')"
      >移除</el-button
    >
  </div>
</template>
