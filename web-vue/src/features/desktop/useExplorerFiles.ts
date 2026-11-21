import { nextTick, onMounted, onScopeDispose, shallowRef, watch } from "vue";
import type { Chat } from "../../composables/useChat";
import type { ExplorerAttachment } from "../../platform/contracts";
import platform from "virtual:pulse-platform";

interface ComposerActions {
  insertExplorerFiles(files: ExplorerAttachment[]): boolean;
  focusEditor(): void;
}

export function useExplorerFiles(chat: Chat, composer: () => ComposerActions | null) {
  const files = shallowRef<ExplorerAttachment[]>([]);
  const busy = shallowRef(false);
  const issue = shallowRef("");
  const desktop = platform.windowKind === "workspace" ? platform.explorerFiles : undefined;
  if (!desktop) return { files, busy, issue, attach: undefined, cancel: undefined };

  const token = chat.client.token;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  let reading = false;
  let dirty = true;
  const current = () => !disposed && !chat.locked.value && chat.foreground.value &&
    !!chat.me.value && chat.client.token === token;

  async function refresh() {
    if (!current() || reading || busy.value || !dirty) return;
    reading = true;
    try {
      do {
        dirty = false;
        const pending = await desktop!.pending(token);
        if (current() && !busy.value) files.value = pending;
        else dirty = true;
      } while (dirty && current() && !busy.value);
    } catch {
      dirty = true;
    } finally {
      reading = false;
    }
  }
  onMounted(async () => {
    try {
      unsubscribe = await desktop.subscribe((warning) => {
        if (warning && current()) chat.error(Error(warning));
        dirty = true;
        void refresh();
      });
      if (disposed) { unsubscribe(); return; }
    } catch { /* The initial read also covers startup without a listener. */ }
    void refresh();
  });
  watch([chat.me, chat.locked, chat.foreground], () => {
    if (!current()) files.value = [];
    dirty = true;
    void refresh();
  });
  onScopeDispose(() => { disposed = true; unsubscribe?.(); });

  async function attach(conversation: number) {
    if (busy.value || !current() || !files.value.length) return;
    if (chat.active.value?.id !== conversation && chat.interactionBusy.value) {
      issue.value = "请先处理当前会话中的附件。";
      return;
    }
    const ids = files.value.map(({ id }) => id);
    let claimed = false;
    let inserted = false;
    busy.value = true;
    issue.value = "";
    try {
      if (chat.active.value?.id !== conversation || chat.loading.value || chat.openingError.value)
        await chat.choose(conversation);
      if (!current()) return;
      if (!chat.canSend.value || chat.active.value?.id !== conversation) {
        issue.value = "暂时无法在这个会话发送文件，请重试或选择其他会话。";
        return;
      }
      await nextTick();
      const editor = composer();
      if (!editor) throw Error("暂时无法打开输入框，请重试。");
      const selected = await desktop!.claim(token, ids);
      claimed = true;
      if (!current() || chat.active.value?.id !== conversation || composer() !== editor) return;
      // Claim and insert into the same workspace and account that selected the target.
      inserted = editor.insertExplorerFiles(selected);
      if (!inserted) throw Error("当前输入框无法再添加附件。每条消息最多添加 10 个附件。");
      files.value = [];
      chat.panel.value = "none";
      await nextTick();
      if (current()) editor.focusEditor();
    } catch (cause) {
      if (current()) issue.value = typeof cause === "string" ? cause :
        cause instanceof Error ? cause.message : "暂时无法添加文件，请重新选择。";
    } finally {
      if (claimed && !inserted) await desktop!.unclaim(token, ids).catch(() => {});
      busy.value = false;
      dirty = true;
      void refresh();
    }
  }
  async function cancel() {
    if (busy.value || !current()) return;
    busy.value = true;
    try {
      await desktop!.discard(token, files.value.map(({ id }) => id));
      files.value = [];
      issue.value = "";
    } catch {
      if (current()) issue.value = "无法取消这些附件，请重试。";
    } finally {
      busy.value = false;
      dirty = true;
      void refresh();
    }
  }
  return { files, busy, issue, attach, cancel };
}
