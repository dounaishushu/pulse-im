import { onScopeDispose, shallowRef, watch } from "vue";
import platform from "virtual:pulse-platform";
import type { Chat } from "../../composables/useChat";

export function useComposerScreenshot(chat: Chat, insert: (file: File) => void) {
  const busy = shallowRef(false);
  let capture: AbortController | undefined;
  async function take() {
    const screenshot = platform.screenshot;
    const conversation = chat.active.value?.id;
    if (!screenshot || !conversation || !chat.canSend.value || capture) return;
    const controller = new AbortController();
    capture = controller;
    busy.value = true;
    try {
      const file = await screenshot.take(controller.signal);
      if (file && !controller.signal.aborted && chat.active.value?.id === conversation && chat.canSend.value) {
        insert(file);
      }
    } catch (cause) {
      if (!controller.signal.aborted) chat.error(cause);
    } finally {
      if (capture === controller) {
        capture = undefined;
        busy.value = false;
      }
    }
  }
  if (platform.screenshot) {
    watch([() => chat.active.value?.id, chat.canSend], () => capture?.abort(), { flush: "sync" });
    onScopeDispose(() => capture?.abort());
  }
  return { available: !!platform.screenshot, busy, take };
}
