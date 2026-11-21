import { invoke } from "@tauri-apps/api/core";
import type { DesktopScreenshot, ScreenshotOverlay } from "../../web-vue/src/platform/contracts";

export const desktopScreenshot: DesktopScreenshot = {
  async take(signal) {
    signal.throwIfAborted();
    const id = await invoke<string>("begin_screen_capture");
    const cancel = () => { void invoke("cancel_screen_capture", { id }).catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const bytes = await invoke<ArrayBuffer>("take_screen_capture", { id });
      signal.throwIfAborted();
      return bytes.byteLength
        ? new File([bytes], `截图-${Date.now()}.png`, { type: "image/png" })
        : null;
    } catch (cause) {
      cancel();
      throw typeof cause === "string" ? new Error(cause) : cause;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  },
};

export const screenshotOverlay: ScreenshotOverlay = {
  async preview() {
    const bytes = await invoke<ArrayBuffer>("screen_capture_preview");
    if (bytes.byteLength <= 8) throw new Error("截图预览格式无效。");
    const dimensions = new DataView(bytes);
    return {
      image: new Blob([bytes.slice(8)], { type: "image/jpeg" }),
      width: dimensions.getUint32(0, true),
      height: dimensions.getUint32(4, true),
    };
  },
  complete: (selection) => invoke("complete_screen_capture", { selection }),
  cancel: () => invoke("cancel_screen_capture"),
};
