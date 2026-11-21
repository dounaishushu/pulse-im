import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { DesktopExplorerFiles, ExplorerAttachment } from "../../web-vue/src/platform/contracts";
import { desktopSessionLease } from "./archive";

type FileDetails = Omit<ExplorerAttachment, "source">;
function forComposer(details: FileDetails[]): ExplorerAttachment[] {
  return details.map((file) => ({ ...file, source: "explorer" }));
}

export const desktopExplorerFiles: DesktopExplorerFiles = {
  pending: async (token) => forComposer(await invoke<FileDetails[]>("pending_explorer_files", {
    lease: await desktopSessionLease(token),
  })),
  claim: async (token, ids) => forComposer(await invoke<FileDetails[]>("claim_explorer_files", {
    lease: await desktopSessionLease(token), ids,
  })),
  unclaim: async (token, ids) => invoke("unclaim_explorer_files", {
    lease: await desktopSessionLease(token), ids,
  }),
  discard: async (token, ids) => invoke("discard_explorer_files", {
    lease: await desktopSessionLease(token), ids,
  }),
  subscribe: (listener) => getCurrentWebviewWindow().listen<string | null>(
    "pulse-explorer-files", ({ payload }) => listener(payload),
  ),
};

export async function prepareExplorerUpload(id: string, token: string) {
  return invoke<{ id: string; sha256: string }>("prepare_explorer_file", {
    lease: await desktopSessionLease(token), id,
  }).catch((cause: unknown) => {
    if (cause === "upload_stage_busy") throw Error("待发送的文件较多，请稍后重试。");
    if (typeof cause === "string" && cause.startsWith("所选文件")) throw Error(cause);
    throw Error("无法准备资源管理器中的附件，请检查文件或重新选择。");
  });
}
