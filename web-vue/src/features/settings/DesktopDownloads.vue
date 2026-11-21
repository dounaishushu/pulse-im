<script setup lang="ts">
import { inject, onMounted, onScopeDispose, shallowRef, watch } from "vue";
import platform from "virtual:pulse-platform";
import type { DesktopDownloadPreferences, DownloadTask } from "../../platform/contracts";
import { chatKey } from "../../composables/useChat";

const props = defineProps<{ restored?: DesktopDownloadPreferences }>();
const service = platform.downloads!;
const chat = inject(chatKey)!;
const token = chat.client.token;
const preferences = shallowRef(props.restored);
const tasks = shallowRef<DownloadTask[]>([]);
const error = shallowRef("");
const savingPreferences = shallowRef(false);
let alive = true;
let timer: ReturnType<typeof setTimeout> | undefined;
const labels: Record<DownloadTask["status"], string> = {
  queued: "等待下载", running: "下载中", saved: "已保存", failed: "下载失败", cancelled: "已取消",
};
const current = () => alive && chat.client.token === token;
const textOf = (cause: unknown) => typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "暂时无法读取下载设置。";

async function poll() {
  if (!current()) return;
  try {
    const rows = await service.list(token);
    if (current()) tasks.value = rows;
  } catch (cause) {
    if (current()) error.value = textOf(cause);
  } finally {
    if (current()) timer = setTimeout(() => { void poll(); }, 750);
  }
}
async function updatePreferences(change: () => Promise<DesktopDownloadPreferences | null>) {
  if (savingPreferences.value || !current() || chat.locked.value) return;
  savingPreferences.value = true;
  try {
    const next = await change();
    if (current() && next) {
      preferences.value = next;
      error.value = "";
    }
  } catch (cause) {
    if (current()) error.value = textOf(cause);
  } finally {
    savingPreferences.value = false;
  }
}

function changePrompt(event: Event) {
  const input = event.target as HTMLInputElement;
  const checked = input.checked;
  // Keep the control in sync with the last value confirmed on disk.
  input.checked = preferences.value?.askBeforeDownload ?? true;
  void updatePreferences(() => service.setAskBeforeDownload(token, checked));
}
async function cancel(id: string) {
  try { await service.cancel(id, token); }
  catch (cause) { if (current()) error.value = textOf(cause); }
}

watch(() => props.restored, (value) => {
  if (value && current()) preferences.value = value;
});
onMounted(() => {
  void service.preferences(token).then((value) => {
    if (current() && !props.restored) preferences.value = value;
  }).catch((cause) => { if (current()) error.value = textOf(cause); });
  void poll();
});
onScopeDispose(() => {
  alive = false;
  clearTimeout(timer);
});
</script>

<template>
  <section class="download-settings">
    <h3>下载任务</h3>
    <label class="vue-toggle">
      <input
        type="checkbox"
        :checked="preferences?.askBeforeDownload ?? true"
        :disabled="!preferences || savingPreferences"
        @change="changePrompt"
      />
      <span>下载前询问保存目录</span>
    </label>
    <div class="download-directory">
      <span class="path" :title="preferences?.directory">{{ preferences?.directory || '默认下载目录' }}</span>
      <button
        type="button"
        :disabled="!preferences || savingPreferences"
        @click="updatePreferences(() => service.chooseDirectory(token))"
      >选择目录</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!tasks.length">暂无下载任务</p>
    <ul v-else class="download-list">
      <li v-for="task in tasks" :key="task.id" class="download-task">
        <div class="task-main">
          <strong class="path" :title="task.savedPath || task.name">{{ task.name }}</strong>
          <progress
            v-if="task.status === 'running'"
            aria-label="下载进度"
            :value="task.total ? task.received : undefined"
            :max="task.total || 1"
          ></progress>
          <span>{{ task.error || labels[task.status] }}</span>
        </div>
        <button v-if="task.status === 'queued' || task.status === 'running'" type="button" @click="cancel(task.id)">取消</button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.download-settings {
  display: grid;
  gap: 8px;
  padding-block: 12px;
}
.download-settings h3,
.download-settings p {
  margin: 0;
}
.download-directory,
.download-task {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.download-directory button,
.download-task button {
  flex: none;
}
.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.download-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style-type: none;
}
.download-task {
  padding: 8px 10px;
  border: 1px solid var(--ui-line);
  border-radius: 8px;
  color: var(--ui-muted);
}
.task-main {
  display: grid;
  min-width: 0;
  gap: 4px;
}
.task-main strong {
  color: var(--ui-text);
}
.task-main progress {
  width: 100%;
  accent-color: var(--ui-primary);
}
</style>
