import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { ArchiveSession, ArchiveUpdate, ConversationWindowContext, DesktopArchive, DesktopArchiveWindow, DesktopChatWindows } from "../../web-vue/src/platform/contracts";

let binding: { token: string; ready: Promise<string | null>; opened: boolean } | undefined;
let updating: Promise<string | null> = Promise.resolve(null);
const relaying = new Set<string>();

/** Serialize account changes so a prior login cannot replace the current owner. */
function setSession(input: ArchiveSession | null) {
  const ready = updating.catch(() => null).then(() => invoke<string | null>("set_archive_session", { input }));
  updating = ready;
  binding = input ? { token: input.token, ready, opened: false } : undefined;
  void ready.catch(() => {});
}

async function authorized(token: string) {
  const captured = binding;
  const lease = captured?.token === token ? await captured.ready : null;
  if (!lease || !captured || captured !== binding) throw Error("当前账号已切换，请重新打开窗口。");
  return { lease, captured };
}

export async function desktopSessionLease(token: string): Promise<string> {
  return (await authorized(token)).lease;
}

export const chatWindows: DesktopChatWindows = {
  outbox: (action) => invoke("chat_outbox_action", { action }),
  onOutboxStatus: (callback) => getCurrentWebviewWindow().listen<import("../../web-vue/src/platform/contracts").ChatOutboxSnapshot>(
    "pulse-chat-outbox-status", ({ payload }) => callback(payload),
  ),
  onOutboxRequest: (callback) => getCurrentWebviewWindow().listen<import("../../web-vue/src/platform/contracts").ChatOutboxRequest>(
    "pulse-chat-outbox-request", ({ payload }) => callback(payload),
  ),
  replyOutbox: (token, request, snapshot, error) => invoke("reply_chat_outbox", { token, reply: { request, snapshot, error } }),
  publishOutbox: (token, conversation, snapshot) => invoke("publish_chat_outbox", { token, conversation, snapshot }),
  async open(token, input) {
    const { lease } = await authorized(token);
    if (getCurrentWebviewWindow().label.startsWith("conversation-")) {
      await invoke("open_chat_window", { lease, input });
      return;
    }
    // Relay hints from the account's existing connection while the child starts.
    const alreadyRelaying = relaying.has(token);
    relaying.add(token);
    try {
      await invoke("open_chat_window", { lease, input });
    } catch (cause) {
      if (!alreadyRelaying) relaying.delete(token);
      throw cause;
    }
  },
  closeAll(token) {
    if (token) relaying.delete(token);
    else relaying.clear();
    void invoke("close_chat_windows", { token }).catch(() => {});
  },
  relay(token, packet) {
    if (relaying.has(token)) void invoke("relay_chat_window_packet", { token, packet }).catch(() => {});
  },
  async context() {
    const context = await invoke<ConversationWindowContext>("chat_window_context");
    binding = { token: context.token, ready: Promise.resolve(context.lease), opened: false };
    return context;
  },
  subscribe: (callback) => getCurrentWebviewWindow().listen<import("../../web-vue/src/api/types").Packet>(
    "pulse-conversation-window-packet", (event) => callback(event.payload),
  ),
  close: () => invoke("close_archive_window"),
};

export const desktopArchive: DesktopArchive = {
  setSession,
  async openHistory(token, input) {
    const { lease, captured } = await authorized(token);
    captured.opened = true;
    await invoke("open_archive_history", { lease, input });
  },
  async openImage(token, conversation, message, eventSeq) {
    const { lease, captured } = await authorized(token);
    captured.opened = true;
    await invoke("open_archive_image", { lease, conversation, message, eventSeq });
  },
  async copyImage(token, conversation, message) {
    const { lease } = await authorized(token);
    try {
      await invoke("copy_conversation_image", { lease, conversation, message });
    } catch (cause) {
      throw typeof cause === "string" ? new Error(cause) : cause;
    }
  },
  invalidate(token, conversation) {
    if (!binding?.opened || binding.token !== token) return;
    void authorized(token)
      .then(({ lease }) => invoke("invalidate_archive", { lease, conversation }))
      .catch(() => {});
  },
  observe(token, conversation, through) {
    if (!binding?.opened || binding.token !== token) return;
    void authorized(token)
      .then(({ lease }) => invoke("observe_archive_event", { lease, conversation, through }))
      .catch(() => {});
  },
};

export const archiveWindow: DesktopArchiveWindow = {
  history: () => invoke("archive_history_context"),
  page: (older) => invoke("archive_history_page", { older }),
  assets: (ids) => invoke("archive_history_assets", { ids }),
  copyText: (message) => invoke("archive_copy_text", { message }),
  copyImage: (message) => invoke("archive_copy_image", { message }),
  download: (message) => invoke("archive_download_file", { message }),
  preview: (message) => invoke("open_archive_image", { message }),
  image: () => invoke("archive_image"),
  onHistoryChange: (callback) => getCurrentWebviewWindow().listen<ArchiveUpdate>(
    "pulse-archive-refresh", (event) => callback(event.payload),
  ),
  onImageChange: (callback) => getCurrentWebviewWindow().listen("pulse-archive-image", callback),
  close: () => invoke("close_archive_window"),
};
