<script setup lang="ts">
import { computed, inject, useTemplateRef } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import UiIcon from "../../components/UiIcon.vue";
import { chatKey } from "../../composables/useChat";
import AttachmentCard from "../chat/AttachmentCard.vue";
import { useBroadcastTask } from "./useBroadcastTask";

const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const {
  batch, kind, search, targets, targetError, searching, more, selected,
  body, files, busy, canCreate, taskState, taskProgress, error,
  addFiles, removeFile, load, choose, check, send, control,
} = useBroadcastTask(chat);
const picker = useTemplateRef<HTMLInputElement>("picker");
const allVisible = computed(() => targets.value.length > 0 && targets.value.every((row) => selected.value.has(row.id)));
</script>

<template>
  <BaseDialog title="群发任务" size="wide" :busy="busy" @close="emit('close')">
    <form class="broadcast-form" @submit.prevent="send">
      <div class="broadcast-targets">
        <div class="broadcast-tabs" role="group" aria-label="群发对象类型">
          <button type="button" :aria-pressed="kind === 'friend'" :disabled="busy" @click="kind = 'friend'">好友</button>
          <button type="button" :aria-pressed="kind === 'group'" :disabled="busy" @click="kind = 'group'">群组</button>
        </div>
        <input v-model="search" type="search" :disabled="busy" maxlength="100"
          :placeholder="kind === 'friend' ? '搜索好友昵称、备注或账号' : '搜索群组'" aria-label="搜索群发接收者" />
        <div class="broadcast-recipients" aria-label="群发接收者">
          <label v-for="row in targets" :key="row.id">
            <input type="checkbox" :checked="selected.has(row.id)" :disabled="busy"
              @change="choose([row], ($event.target as HTMLInputElement).checked)" />
            <span :title="row.name">{{ row.display_name || row.name || row.username }}</span>
          </label>
          <p v-if="searching && !targets.length" role="status">正在加载接收者…</p>
          <p v-else-if="!targetError && !targets.length">没有匹配的接收者</p>
          <button v-if="targetError" type="button" @click="load()">{{ targetError }}，重试</button>
          <button v-else-if="more" type="button" :disabled="busy || searching" @click="load(true)">加载更多</button>
        </div>
        <button type="button" class="ui-text-button" :disabled="busy || !targets.length" @click="choose(targets, !allVisible)">
          {{ allVisible ? "取消当前选择" : "全选当前结果" }}
        </button>
      </div>
      <div class="broadcast-content">
        <label>消息<textarea v-model="body" :disabled="busy" maxlength="5000" /></label>
        <input ref="picker" hidden type="file" multiple accept="image/*,video/*,.mkv,.avi,.ogv,.m4v,.wmv,.mpeg" @change="addFiles" />
        <button type="button" class="ui-text-button" :disabled="busy" @click="picker?.click()">
          <UiIcon name="paperclip" /> 添加图片或视频
        </button>
        <div v-if="files.length" class="broadcast-files">
          <AttachmentCard v-for="{id, file} in files" :key="id" layout="composer" :filename="file.name" :mime="file.type" :bytes="file.size">
            <button class="ui-icon-button" type="button" :disabled="busy" :aria-label="'移除 ' + file.name" @click="removeFile(file)"><UiIcon name="close" /></button>
          </AttachmentCard>
        </div>
        <p v-if="error" role="alert">{{ error }}</p>
        <div class="broadcast-submit">
          <span>已选 {{ selected.size }} 个接收者</span>
          <button class="primary" :disabled="!canCreate">{{ busy ? "处理中…" : "创建任务" }}</button>
        </div>
      </div>
    </form>
    <div v-if="batch || taskProgress" class="broadcast-status">
      <span role="status">{{ taskProgress }}</span>
      <button v-if="batch" type="button" :disabled="busy" @click="check">刷新进度</button>
      <button v-if="taskState === 'partial'" type="button" :disabled="busy" @click="control('retry')">重试未完成目标</button>
      <button v-if="['pending', 'running', 'partial'].includes(taskState)" type="button" :disabled="busy" @click="control('cancel')">取消剩余任务</button>
    </div>
  </BaseDialog>
</template>

<style scoped>
.broadcast-form {
  display: grid;
  grid-template-columns: minmax(170px, 0.85fr) minmax(0, 1.15fr);
  gap: 18px;
  padding: 14px var(--ui-space-dialog);
}
.broadcast-form label { margin-block: 0; }
.broadcast-targets, .broadcast-content { min-width: 0; display: grid; align-content: start; gap: 8px; }
.broadcast-tabs, .broadcast-submit, .broadcast-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.broadcast-tabs button[aria-pressed="true"] { color: var(--ui-primary); background: var(--art-active-color); }
.broadcast-submit { justify-content: space-between; }
.broadcast-recipients, .broadcast-files { max-height: 228px; overflow: auto; scrollbar-width: thin; }
.broadcast-recipients label { padding: 5px 0; }
.broadcast-status { border-top: 1px solid var(--ui-line); padding: 10px var(--ui-space-dialog); }
.broadcast-status span { margin-inline-end: auto; }
@media (max-width: 560px) { .broadcast-form { grid-template-columns: minmax(0, 1fr); gap: 12px; } }
</style>
