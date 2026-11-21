<script setup lang="ts">
import { onMounted, onScopeDispose, shallowRef } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import UiIcon from "../../components/UiIcon.vue";
import type { DesktopWorkspaces, WorkspaceGroup } from "../../platform/contracts";

const { workspaces } = defineProps<{ workspaces: DesktopWorkspaces }>();
const emit = defineEmits<{ close: [] }>();
const groups = shallowRef<WorkspaceGroup[]>([]);
const busy = shallowRef(false);
const error = shallowRef("");
const importStatus = shallowRef("");
let disposed = false;

async function run(action: () => Promise<void>, close = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
    if (close && !disposed) emit("close");
  } catch (cause) {
    if (!disposed) error.value = typeof cause === "string" ? cause : "暂时无法操作窗口，请重试。";
  } finally {
    if (!disposed) busy.value = false;
  }
}

async function refresh() {
  const items = await workspaces.list();
  if (!disposed) groups.value = items;
}
function importLegacy() {
  importStatus.value = "";
  return run(async () => {
    const added = await workspaces.importLegacy();
    if (disposed || added === null) return;
    await refresh();
    if (!disposed) importStatus.value = added > 0 ? `已导入 ${added} 个独立窗口，请在对应窗口重新登录。` : "没有需要新增的窗口。";
  });
}
onMounted(() => run(refresh));
onScopeDispose(() => { disposed = true; });
</script>

<template>
  <BaseDialog title="账号窗口" size="compact" :busy="busy" @close="emit('close')">
    <div class="workspace-window-actions">
      <button type="button" class="primary" :disabled="busy" @click="run(() => workspaces.open(), true)">
        <UiIcon name="plus" /> 新建独立窗口
      </button>
      <button v-if="groups.some(group => group.current)" type="button" :disabled="busy" @click="run(() => workspaces.primary(), true)">
        返回主窗口
      </button>
      <button type="button" :disabled="busy" title="选择旧版的 account-profiles.json" @click="importLegacy">
        导入旧版窗口
      </button>
    </div>
    <p v-if="error" class="workspace-window-error" role="alert">{{ error }}</p>
    <p v-if="importStatus" class="workspace-window-import-status" role="status">{{ importStatus }}</p>
    <ul v-if="groups.length" class="workspace-window-list" aria-label="独立窗口列表">
      <li v-for="group in groups" :key="group.id">
        <button type="button" class="workspace-window-row" :disabled="busy || group.current" @click="run(() => workspaces.open(group.id), true)">
          <UiIcon name="profile" />
          <span>{{ group.title }}</span>
          <small>{{ group.current ? "当前窗口" : group.opened ? "切换" : "打开" }}</small>
        </button>
      </li>
    </ul>
  </BaseDialog>
</template>

<style scoped>
.workspace-window-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.workspace-window-import-status { margin-top: 10px; color: var(--ui-muted); }
.workspace-window-error { margin-top: 10px; color: var(--ui-danger); }
.workspace-window-list { display: grid; gap: 4px; margin: 12px 0 0; padding: 10px 0 0; border-top: 1px solid var(--ui-line); list-style: none; }
.workspace-window-row { display: flex; align-items: center; gap: 9px; min-height: 38px; width: 100%; text-align: start; }
.workspace-window-row > .ui-icon { color: var(--ui-muted); }
.workspace-window-row small { margin-inline-start: auto; color: var(--ui-muted); }
</style>
