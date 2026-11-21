<script setup lang="ts">
import UiIcon from "../../components/UiIcon.vue";
import AttachmentCard from "./AttachmentCard.vue";

import type { UploadAttachment } from "../../platform/contracts";

defineProps<{ file: UploadAttachment }>();
const emit = defineEmits<{ remove: [] }>();
</script>

<template>
  <AttachmentCard
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
</template>

<style scoped>
.composer-file-remove {
  width: 26px;
  height: 26px;
  font-size: 14px;
}
</style>
