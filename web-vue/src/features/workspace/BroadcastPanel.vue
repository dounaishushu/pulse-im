<script setup lang="ts">
import { computed, inject, useTemplateRef } from "vue";
import AvatarImage from "../../components/AvatarImage.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import UiIcon from "../../components/UiIcon.vue";
import { chatKey } from "../../composables/useChat";
import AttachmentCard from "../chat/AttachmentCard.vue";
import { useBroadcastTask } from "./useBroadcastTask";

const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const {
  batch, kind, search, targets, targetError, searching, more, counts, selecting, allSelected, selected,
  body, files, busy, canCreate, taskState, taskProgress, error,
  addFiles, removeFile, load, choose, chooseAll, check, send, control,
} = useBroadcastTask(chat);
const imagePicker = useTemplateRef<HTMLInputElement>("imagePicker");
const videoPicker = useTemplateRef<HTMLInputElement>("videoPicker");
const inputBusy = computed(() => busy.value || selecting.value);
const partiallySelected = computed(() => !allSelected.value && targets.value.some(row => selected.value.has(row.id)));
const contentLabel = computed(() => {
  const image = files.value.some(row => row.kind === "image"), video = files.value.some(row => row.kind === "video");
  return image && video ? "图文及视频消息" : image ? "图片消息" : video ? "视频消息" : "文字消息";
});
function toggleRecipient(row: (typeof targets.value)[number], event: Event) {
  const input = event.target as HTMLInputElement;
  choose([row], input.checked);
  input.checked = selected.value.has(row.id);
}
async function toggleAll(event: Event) {
  const input = event.target as HTMLInputElement;
  await chooseAll(input.checked);
  input.checked = allSelected.value;
  input.indeterminate = partiallySelected.value;
}
function scrollTargets(event: Event) {
  const element = event.currentTarget as HTMLElement;
  if (more.value && !inputBusy.value && !searching.value && !targetError.value &&
    element.scrollHeight - element.scrollTop - element.clientHeight < 80) void load(true);
}
</script>

<template>
  <BaseDialog title="群发消息" layout="broadcast" :busy="inputBusy" @close="emit('close')">
    <form id="broadcast-message-form" class="broadcast-form" @submit.prevent="send">
      <section class="broadcast-targets" aria-label="选择发送目标">
        <div class="broadcast-section-heading">
          <h3>选择发送目标</h3><span aria-live="polite">已选 {{ selected.size }} 个</span>
        </div>
        <div class="broadcast-tabs" role="tablist" aria-label="群发对象类型">
          <button id="broadcast-friends-tab" type="button" role="tab" :aria-selected="kind === 'friend'"
            aria-controls="broadcast-recipients" :disabled="inputBusy" @click="kind = 'friend'">
            好友<span v-if="counts.friend !== undefined"> ({{ counts.friend }})</span>
          </button>
          <button id="broadcast-groups-tab" type="button" role="tab" :aria-selected="kind === 'group'"
            aria-controls="broadcast-recipients" :disabled="inputBusy" @click="kind = 'group'">
            群组<span v-if="counts.group !== undefined"> ({{ counts.group }})</span>
          </button>
        </div>
        <div class="broadcast-search">
          <UiIcon name="search" />
          <input v-model="search" data-dialog-autofocus type="search" :disabled="inputBusy" maxlength="100"
            :placeholder="kind === 'friend' ? '搜索好友备注/昵称/账号' : '搜索群名称/ID'" aria-label="搜索群发接收者" />
        </div>
        <label class="broadcast-select-all">
          <input type="checkbox" :checked="allSelected" :indeterminate="partiallySelected"
            :disabled="inputBusy || searching || !targets.length" @change="toggleAll" />
          <span>{{ selecting ? '正在全选…' : '全选' }}</span>
        </label>
        <div id="broadcast-recipients" class="broadcast-recipients" role="tabpanel"
          :aria-labelledby="kind === 'friend' ? 'broadcast-friends-tab' : 'broadcast-groups-tab'"
          :aria-busy="searching || selecting" @scroll.passive="scrollTargets">
          <label v-for="row in targets" :key="kind + row.id" class="broadcast-recipient" :class="{ 'is-selected': selected.has(row.id) }">
            <input type="checkbox" :checked="selected.has(row.id)" :disabled="inputBusy"
              :aria-label="'选择 ' + (row.display_name || row.name || row.username || row.public_id)"
              @change="toggleRecipient(row, $event)" />
            <AvatarImage :name="row.display_name || row.name || row.username" :media-id="row.avatar_id" />
            <span class="broadcast-recipient-text">
              <span class="broadcast-recipient-name" :title="row.display_name || row.name || row.username">{{ row.display_name || row.name || row.username || row.public_id }}</span>
              <small>{{ kind === 'friend' ? '好友' : '群组' }}</small>
            </span>
          </label>
          <p v-if="searching && !targets.length" class="broadcast-empty" role="status">正在加载接收者…</p>
          <p v-else-if="!targetError && !targets.length" class="broadcast-empty">没有匹配的接收者</p>
          <button v-if="targetError" class="broadcast-load ui-text-button" type="button" :disabled="inputBusy" @click="load(!!targets.length)">{{ targetError }}，重试</button>
          <button v-else-if="more" class="broadcast-load ui-text-button" type="button" :disabled="inputBusy || searching" @click="load(true)">{{ searching ? '正在加载…' : '加载更多' }}</button>
        </div>
      </section>
      <section class="broadcast-content" aria-label="编辑消息内容">
        <div class="broadcast-section-heading"><h3>编辑消息内容</h3></div>
        <div class="broadcast-editor">
          <textarea v-model="body" aria-label="群发消息内容" placeholder="输入要群发的消息…" :disabled="busy" maxlength="5000" />
          <span class="broadcast-character-count">{{ body.length }}/5000</span>
        </div>
        <div v-if="files.length" class="broadcast-files" aria-label="已添加的附件">
          <AttachmentCard v-for="{id, file} in files" :key="id" layout="composer" :filename="file.name" :mime="file.type" :bytes="file.size">
            <button class="ui-icon-button" type="button" :disabled="busy" :aria-label="'移除 ' + file.name" @click="removeFile(file)"><UiIcon name="close" /></button>
          </AttachmentCard>
        </div>
        <div class="broadcast-media-actions">
          <input ref="imagePicker" v-show="false" type="file" multiple accept="image/jpeg,image/png,image/gif,image/webp" aria-label="添加群发图片" @change="addFiles" />
          <input ref="videoPicker" v-show="false" type="file" multiple accept="video/*,.mkv,.avi,.ogv,.m4v,.wmv,.mpeg" aria-label="添加群发视频" @change="addFiles" />
          <button type="button" :disabled="busy" @click="imagePicker?.click()"><UiIcon name="image" /> 图片</button>
          <button type="button" :disabled="busy" @click="videoPicker?.click()"><UiIcon name="video" /> 视频</button>
        </div>
      </section>
    </form>
    <p v-if="error" class="broadcast-error" role="alert">{{ error }}</p>
    <div v-if="batch || taskProgress" class="broadcast-status" aria-label="群发任务进度">
      <span role="status" aria-live="polite">{{ taskProgress }}</span>
      <button v-if="batch" type="button" class="ui-text-button" :disabled="busy" @click="check">刷新进度</button>
      <button v-if="taskState === 'partial'" type="button" class="ui-text-button" :disabled="busy" @click="control('retry')">重试未完成目标</button>
      <button v-if="['pending', 'running', 'partial'].includes(taskState)" type="button" class="ui-text-button" :disabled="busy" @click="control('cancel')">取消剩余任务</button>
    </div>
    <template #footer>
      <span class="broadcast-summary">将向 {{ selected.size }} 个目标发送{{ contentLabel }}</span>
      <button class="broadcast-cancel" type="button" :disabled="inputBusy" @click="emit('close')">取消</button>
      <button class="primary broadcast-send" type="submit" form="broadcast-message-form" :disabled="!canCreate">{{ busy ? '处理中…' : '发送' }}</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.broadcast-form { display: grid; grid-template-columns: minmax(0, 0.44fr) minmax(0, 0.56fr); flex: 1; min-height: 0; }
.broadcast-form .broadcast-targets, .broadcast-form .broadcast-content { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.broadcast-form .broadcast-targets { border-inline-end: 1px solid var(--ui-line); }
.broadcast-form .broadcast-section-heading { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 8px; min-height: 38px; padding: 8px 14px; border-bottom: 1px solid var(--ui-line); }
.broadcast-section-heading h3 { font-size: 12px; font-weight: 600; }
.broadcast-section-heading > span { color: var(--ui-primary); font-size: 12px; white-space: nowrap; }
.broadcast-form .broadcast-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); flex: none; border-bottom: 1px solid var(--ui-line); }
.broadcast-form .broadcast-tabs button { min-height: 40px; border-radius: 0; background: transparent; color: var(--ui-muted); border-bottom: 2px solid transparent; }
.broadcast-form .broadcast-tabs button[aria-selected="true"] { color: var(--ui-primary); border-bottom-color: var(--ui-primary); }
.broadcast-form .broadcast-search { display: flex; flex: none; align-items: center; gap: 7px; padding: 6px 14px; border-bottom: 1px solid var(--ui-line); color: var(--ui-muted); }
.broadcast-form .broadcast-search input { min-height: 30px; padding: 5px 7px; border: 1px solid transparent; background: var(--ui-surface-soft); font-size: 12px; }
.broadcast-form .broadcast-select-all, .broadcast-form .broadcast-recipient { display: flex; flex-wrap: nowrap; align-items: center; gap: 10px; margin: 0; padding: 8px 14px; font-size: 12px; }
.broadcast-form .broadcast-select-all { flex: none; min-height: 34px; border-bottom: 1px solid var(--ui-line); color: var(--ui-muted); }
.broadcast-form input[type="checkbox"] { flex: none; width: 15px; height: 15px; margin: 0; }
.broadcast-recipients { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.broadcast-form .broadcast-recipient { min-height: 54px; cursor: pointer; }
.broadcast-form .broadcast-recipient:hover { background: var(--art-hover-color); }
.broadcast-form .broadcast-recipient.is-selected { background: var(--art-active-color); }
.broadcast-recipient .avatar { --avatar-size: 32px; --avatar-radius: 50%; flex: none; }
.broadcast-recipient-text { display: grid; min-width: 0; gap: 3px; }
.broadcast-recipient-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.broadcast-recipient-text small { color: var(--ui-muted); font-size: 11px; }
.broadcast-empty { padding: 30px 14px; color: var(--ui-muted); text-align: center; font-size: 12px; }
.broadcast-form .broadcast-load { width: 100%; white-space: normal; padding: 10px 14px; font-size: 12px; }
.broadcast-editor { display: flex; flex-direction: column; flex: 1; min-height: 96px; }
.broadcast-form .broadcast-content .broadcast-editor textarea { flex: 1; min-height: 60px; padding: 16px; border: 0; border-radius: 0; background: transparent; resize: none; font-size: 13px; line-height: 1.6; }
.broadcast-character-count { flex: none; align-self: flex-end; padding: 6px 16px 16px; font-size: 11px; color: var(--ui-muted); }
.broadcast-files { display: grid; gap: 5px; flex: 0 1 auto; max-height: 130px; min-height: 0; overflow: auto; padding: 6px 14px; scrollbar-width: thin; }
.broadcast-form .broadcast-media-actions { display: flex; flex: none; align-items: center; gap: 8px; min-height: 42px; padding: 6px 16px; border-top: 1px solid var(--ui-line); }
.broadcast-form .broadcast-media-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 26px; padding: 3px 10px; border: 1px solid var(--ui-line); border-radius: 4px; color: var(--ui-muted); background: transparent; font-size: 12px; }
.broadcast-status { display: flex; flex: none; align-items: center; flex-wrap: wrap; gap: 4px 10px; border-top: 1px solid var(--ui-line); padding: 6px 16px; font-size: 12px; }
.broadcast-status > span { margin-inline-end: auto; color: var(--ui-primary); }
.broadcast-status .ui-text-button { padding: 4px 2px; font-size: 12px; }
.broadcast-summary { flex: 1; min-width: 0; color: var(--ui-muted); font-size: 12px; }
.broadcast-cancel, .broadcast-send { flex: none; min-width: 66px; }
@media (max-width: 560px) {
  .broadcast-form { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(150px, 0.9fr); }
  .broadcast-form .broadcast-targets { border-inline-end: 0; border-bottom: 1px solid var(--ui-line); }
  .broadcast-form .broadcast-section-heading { min-height: 32px; padding-block: 6px; }
  .broadcast-form .broadcast-tabs button { min-height: 34px; }
  .broadcast-form .broadcast-select-all { min-height: 29px; padding-block: 4px; }
  .broadcast-form .broadcast-content .broadcast-editor textarea { padding: 10px 14px; }
  .broadcast-editor { min-height: 64px; }
  .broadcast-character-count { padding-block: 2px 6px; }
  .broadcast-files { max-height: 70px; }
  .broadcast-summary { flex-basis: 100%; }
  .broadcast-cancel { margin-inline-start: auto; }
}
</style>
