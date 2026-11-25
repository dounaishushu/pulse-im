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
const deleting = shallowRef<WorkspaceGroup | null>(null);
let disposed = false;
let stopListening: (() => void) | undefined;
let refreshRevision = 0;

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
  const revision = ++refreshRevision;
  const items = await workspaces.list();
  if (!disposed && revision === refreshRevision) groups.value = items;
}
function close() {
  if (busy.value) return;
  if (deleting.value) { deleting.value = null; error.value = ""; }
  else emit("close");
}
function remove() {
  const group = deleting.value;
  if (!group) return;
  return run(async () => {
    await workspaces.remove(group.id);
    if (disposed) return;
    deleting.value = null;
    importStatus.value = "";
    if (group.current) emit("close");
    else await refresh();
  });
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
onMounted(() => run(async () => {
  const stop = await workspaces.subscribe(() => {
    void refresh().catch((cause) => {
      if (!disposed) error.value = typeof cause === "string" ? cause : "暂时无法刷新窗口，请重试。";
    });
  });
  if (disposed) { stop(); return; }
  stopListening = stop;
  await refresh();
}));
onScopeDispose(() => { disposed = true; stopListening?.(); });
</script>

<template>
  <BaseDialog :title="deleting ? '删除窗口' : '账号窗口'" size="compact" :busy="busy" @close="close">
    <p v-if="error" class="workspace-window-error" role="alert">{{ error }}</p>
    <template v-if="deleting">
      <p>确定删除“{{ deleting.accountName || deleting.title }}”窗口？</p>
      <p class="workspace-window-help">该窗口将关闭并从列表移除，账号和聊天记录不会删除。</p>
    </template>
    <template v-else>
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
    <p v-if="importStatus" class="workspace-window-import-status" role="status">{{ importStatus }}</p>
    <ul v-if="groups.length" class="workspace-window-list" aria-label="独立窗口列表">
      <li v-for="group in groups" :key="group.id">
        <button type="button" class="workspace-window-row" :disabled="busy || group.current" @click="run(() => workspaces.open(group.id), true)">
          <UiIcon name="profile" />
          <span class="workspace-window-name" :title="group.accountName || group.title">
            <span>{{ group.accountName || group.title }}</span>
            <small v-if="group.accountName">{{ group.title }}</small>
          </span>
          <small class="workspace-window-state">{{ group.current ? "当前窗口" : group.opened ? "切换" : "打开" }}</small>
        </button>
        <button type="button" class="workspace-window-delete vue-button-danger" :disabled="busy" :aria-label="`删除窗口 ${group.accountName || group.title}`" title="删除窗口" @click="error = ''; deleting = group">删除</button>
      </li>
    </ul>
    </template>
    <template v-if="deleting" #footer>
      <button type="button" data-dialog-autofocus :disabled="busy" @click="close">取消</button>
      <button type="button" class="vue-button-danger" :disabled="busy" @click="remove">{{ busy ? "删除中…" : "确定删除" }}</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.workspace-window-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.workspace-window-import-status { margin-top: 10px; color: var(--ui-muted); }
.workspace-window-error { margin-top: 10px; color: var(--ui-danger); }
.workspace-window-help { margin-top: 10px; color: var(--ui-muted); }
.workspace-window-list { display: grid; gap: 4px; margin: 12px 0 0; padding: 10px 0 0; border-top: 1px solid var(--ui-line); list-style: none; }
.workspace-window-list li { display: flex; gap: 5px; min-width: 0; }
.workspace-window-row { display: flex; flex: 1; align-items: center; gap: 9px; min-width: 0; min-height: 38px; text-align: start; }
.workspace-window-row > .ui-icon { color: var(--ui-muted); }
.workspace-window-name { display: grid; min-width: 0; }
.workspace-window-name > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-window-name small { color: var(--ui-muted); font-size: 11px; }
.workspace-window-state { margin-inline-start: auto; flex: none; color: var(--ui-muted); }
.workspace-window-delete { flex: none; align-self: stretch; }
</style>
