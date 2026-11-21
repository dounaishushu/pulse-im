<script setup lang="ts">
import { computed, shallowRef } from "vue";
import type { Conversation } from "../../api/types";
import type { ExplorerAttachment } from "../../platform/contracts";
import AvatarImage from "../../components/AvatarImage.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import UiIcon from "../../components/UiIcon.vue";
import AttachmentCard from "../chat/AttachmentCard.vue";

const props = defineProps<{
  files: ExplorerAttachment[];
  conversations: Conversation[];
  busy: boolean;
  issue: string;
}>();
const emit = defineEmits<{ cancel: []; attach: [conversation: number] }>();
const query = shallowRef("");
const selected = shallowRef<number>();
const results = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return props.conversations.filter((row) => !row.is_hidden && row.can_send !== false &&
    row.can_publish !== false &&
    (!search || [row.name, row.remark].some((name) => name?.toLocaleLowerCase().includes(search))));
});
const selection = computed(() => results.value.find(({ id }) => id === selected.value));
</script>

<template>
  <BaseDialog title="发送文件到会话" size="compact" :busy="busy" @close="emit('cancel')">
    <div class="explorer-picker">
      <div class="explorer-files" aria-label="所选文件">
        <AttachmentCard v-for="file in files" :key="file.id" layout="composer"
          :filename="file.name" :mime="file.type" :bytes="file.size" />
      </div>
      <div class="explorer-search">
        <UiIcon name="search" />
        <input v-model="query" type="search" placeholder="搜索会话" aria-label="搜索会话"
          :disabled="busy" data-dialog-autofocus />
      </div>
      <div class="explorer-targets" role="group" aria-label="接收会话">
        <label v-for="row in results" :key="row.id" class="explorer-target">
          <AvatarImage :name="row.name" :src="row.avatar_url" />
          <span class="explorer-target-name">{{ row.remark || row.name }}</span>
          <input v-model="selected" type="radio" name="explorer-target" :value="row.id" :disabled="busy" />
        </label>
        <p v-if="!results.length" role="status">{{ query ? "找不到匹配的会话" : "暂无可发送的会话" }}</p>
      </div>
      <p v-if="issue" class="explorer-issue" role="alert">{{ issue }}</p>
    </div>
    <template #footer>
      <button type="button" :disabled="busy" @click="emit('cancel')">取消</button>
      <button type="button" class="primary" :disabled="busy || !selection"
        @click="selection && emit('attach', selection.id)">{{ busy ? "正在添加…" : "添加到输入框" }}</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.explorer-picker {
  display: grid;
  gap: 10px;
  padding: 14px var(--ui-space-dialog);
}
.explorer-files, .explorer-targets {
  display: grid;
  gap: 4px;
  overflow: auto;
  scrollbar-width: thin;
}
.explorer-files { max-height: 24vh; }
.explorer-targets { max-height: 34vh; }
.explorer-search, .explorer-target {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}
.explorer-search {
  padding-inline: 8px;
  border: 1px solid var(--ui-line);
  border-radius: 6px;
  background: var(--ui-surface-soft);
}
.explorer-search:focus-within { border-color: var(--ui-primary); }
.explorer-picker .explorer-search input[type="search"] {
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
}
.explorer-targets > .explorer-target {
  flex-wrap: nowrap;
  margin: 0;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.explorer-target:hover, .explorer-target:has(input:checked) { background: var(--art-active-color); }
.explorer-target .avatar { --avatar-size: 29px; }
.explorer-target-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.explorer-target input { accent-color: var(--ui-primary); }
.explorer-issue { margin: 0; }
</style>
