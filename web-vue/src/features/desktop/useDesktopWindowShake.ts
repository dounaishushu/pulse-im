import { onScopeDispose, watch, type Ref } from "vue";
import platform from "virtual:pulse-platform";
import type { Chat } from "../../composables/useChat";
import { usePreferences } from "../../composables/usePreferences";

export function useDesktopWindowShake(chat: Chat, viewport: Readonly<Ref<HTMLElement | null>>) {
  if (platform.name !== "pc") return;
  const preferences = usePreferences();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let animation: Animation | undefined;
  function stop() {
    animation?.cancel();
    animation = undefined;
  }
  watch(chat.shakeRevision, () => {
    stop();
    if (!viewport.value || chat.locked.value || !chat.foreground.value || document.hidden ||
      reducedMotion.matches || !preferences.setting("animations")) return;
    animation = viewport.value.animate(
      [0, -7, 6, -4, 3, -1, 0].map(x => ({ transform: `translateX(${x}px)` })),
      { duration: 420, easing: "ease-in-out" },
    );
  });
  watch([() => chat.active.value?.id, chat.locked, chat.foreground], stop, { flush: "sync" });
  onScopeDispose(stop);
}
