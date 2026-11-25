import { createApp, defineComponent, h, shallowRef } from "vue";
import "../src/App.vue";
import WorkspaceWindows from "../src/features/desktop/WorkspaceWindows.vue";
import type { DesktopWorkspaces, WorkspaceGroup } from "../src/platform/contracts";

const rows: WorkspaceGroup[] = [
  { id: "00000001-eeee-4eee-8eee-eeeeeeeeeeee", title: "独立窗口 1", accountName: "登录账号甲", opened: true, current: false },
  { id: "00000002-eeee-4eee-8eee-eeeeeeeeeeee", title: "独立窗口 2", opened: false, current: false },
  { id: "00000003-eeee-4eee-8eee-eeeeeeeeeeee", title: "独立窗口 3", accountName: "当前账号乙", opened: true, current: true },
];
const listeners = new Set<() => void>();
const state = {
  rows, calls: [] as { action: string; id?: string }[], closed: 0,
  failRemoval: false, failList: false, subscribers: 0,
  returnedLists: 0,
  update() { for (const listener of listeners) listener(); },
  holdList: null as null | (() => Promise<void>),
};
const workspaces: DesktopWorkspaces = {
  async list() {
    const snapshot = state.rows.map(row => ({ ...row }));
    if (state.holdList) await state.holdList();
    state.returnedLists++;
    if (state.failList) throw "暂时无法读取窗口。";
    return snapshot;
  },
  async open(id) { state.calls.push({ action: "open", id }); },
  async primary() { state.calls.push({ action: "primary" }); },
  async importLegacy() { state.calls.push({ action: "import" }); return 0; },
  async remove(id) {
    state.calls.push({ action: "remove", id });
    if (state.failRemoval) throw "窗口删除失败，请重试。";
    state.rows = state.rows.filter(row => row.id !== id);
    state.update();
  },
  async subscribe(listener) {
    listeners.add(listener); state.subscribers = listeners.size;
    return () => { listeners.delete(listener); state.subscribers = listeners.size; };
  },
};
Object.assign(window, { workspaceWindowsTest: state });
createApp(defineComponent({ setup() {
  const visible = shallowRef(true);
  return () => visible.value
    ? h(WorkspaceWindows, { workspaces, onClose: () => { visible.value = false; state.closed++; } })
    : h("button", { onClick: () => { visible.value = true; } }, "重新打开账号窗口");
} })).mount("#app");
