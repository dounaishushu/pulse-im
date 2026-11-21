import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { DesktopChatTypography, TypographyState } from "../../web-vue/src/platform/contracts";

export const chatTypography: DesktopChatTypography = {
  read: () => invoke("chat_typography"),
  save: (value) => invoke("set_chat_typography", { value }),
  importLegacy: () => invoke("import_chat_typography"),
  subscribe: (update) => getCurrentWebviewWindow().listen<TypographyState>(
    "pulse-chat-typography", (event) => update(event.payload),
  ),
};
