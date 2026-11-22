<script setup lang="ts">
import { onScopeDispose, shallowRef, watch } from "vue";
import UiIcon from "../../components/UiIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import AttachmentCard from "./AttachmentCard.vue";
import { imageThumbnail } from "./localImage";

import type { UploadAttachment } from "../../platform/contracts";

const props = defineProps<{ file: UploadAttachment }>();
const emit = defineEmits<{ remove: [] }>();
const thumbnail = shallowRef("");
const fullImage = shallowRef("");
function closePreview() {
  if (fullImage.value) URL.revokeObjectURL(fullImage.value);
  fullImage.value = "";
}
function openPreview() {
  if (!(props.file instanceof File) || !thumbnail.value) return;
  closePreview();
  fullImage.value = URL.createObjectURL(props.file);
}
watch(() => props.file, (file, _old, cleanup) => {
  const controller = new AbortController();
  let url = "";
  thumbnail.value = "";
  closePreview();
  cleanup(() => { controller.abort(); if (url) URL.revokeObjectURL(url); });
  void imageThumbnail(file, controller.signal).then(blob => {
    if (controller.signal.aborted || !blob) return;
    url = URL.createObjectURL(blob);
    thumbnail.value = url;
  }).catch(() => {});
}, { immediate: true });
onScopeDispose(closePreview);
</script>

<template>
  <span v-if="thumbnail" class="composer-image-card">
    <button type="button" class="composer-image-thumbnail" :aria-label="`预览 ${file.name}`"
      title="点击放大预览" @mousedown.prevent @click="openPreview">
      <img :src="thumbnail" :alt="file.name" draggable="false" />
    </button>
    <span class="composer-image-name" :title="file.name">{{ file.name }}</span>
    <button type="button" class="ui-icon-button composer-file-remove composer-image-remove"
      :aria-label="`移除 ${file.name}`" title="移除附件" @mousedown.prevent @click="emit('remove')"><UiIcon name="close" /></button>
  </span>
  <AttachmentCard v-else
    layout="composer"
    :filename="file.name"
    :mime="file.type"
    :bytes="file.size"
  >
    <button
      type="button"
      class="ui-icon-button composer-file-remove"
      :aria-label="`移除 ${file.name}`"
      title="移除附件"
      @mousedown.prevent
      @click="emit('remove')"
    >
      <UiIcon name="close" />
    </button>
  </AttachmentCard>
  <BaseDialog v-if="fullImage" title="图片预览" @close="closePreview">
    <img :src="fullImage" class="composer-full-image" :alt="file.name" />
    <p class="composer-preview-name">{{ file.name }}</p>
  </BaseDialog>
</template>

<style scoped>
.composer-file-remove {
  width: 26px;
  height: 26px;
  font-size: 14px;
}
.composer-image-card { display: inline-flex; position: relative; flex-direction: column; width: 156px; max-width: 100%; padding: 5px; gap: 4px; border: 1px solid var(--ui-line); border-radius: 8px; background: var(--ui-surface-soft); vertical-align: middle; }
.composer-image-thumbnail { display: flex; align-items: center; justify-content: center; width: 100%; height: 94px; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
.composer-image-thumbnail img { display: block; max-width: 100%; max-height: 94px; width: auto; height: auto; object-fit: contain; border-radius: 4px; }
.composer-image-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-muted); font-size: 11px; line-height: 1.4; }
.composer-image-remove { position: absolute; top: 4px; right: 4px; border-radius: 50%; background: var(--ui-surface); box-shadow: 0 1px 4px #0002; }
.composer-full-image { display: block; width: auto; max-width: 100%; max-height: 65vh; height: auto; object-fit: contain; margin: auto; }
.composer-preview-name { margin: 8px 0 0; overflow-wrap: anywhere; color: var(--ui-muted); font-size: 12px; text-align: center; }
</style>
