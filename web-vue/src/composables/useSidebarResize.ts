import { onScopeDispose, shallowRef } from "vue";
export function useSidebarResize() {
  const clamp = (value: number) =>
    Math.round(
      Math.min(
        Math.max(
          170,
          Math.min(
            500,
            window.innerWidth /
              (Number(document.documentElement.style.zoom) || 1) -
              280,
          ),
        ),
        Math.max(170, Number.isFinite(value) ? value : 334),
      ),
    );
  const sidebarWidth = shallowRef(
    clamp(Number(localStorage.getItem("pulse_sidebar_width") || 334)),
  );
  let cancel: (() => void) | undefined;
  function save() {
    localStorage.setItem("pulse_sidebar_width", String(sidebarWidth.value));
  }
  function keyboardResize(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    sidebarWidth.value = clamp(
      event.key === "Home"
        ? 170
        : event.key === "End"
          ? 500
          : sidebarWidth.value + (event.key === "ArrowRight" ? 10 : -10),
    );
    save();
  }
  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    cancel?.();
    const start = event.clientX,
      width = sidebarWidth.value,
      controller = new AbortController();
    const zoom = Number(document.documentElement.style.zoom) || 1;
    document.body.style.userSelect = "none";
    cancel = () => {
      controller.abort();
      document.body.style.userSelect = "";
      save();
      cancel = undefined;
    };
    window.addEventListener(
      "pointermove",
      (move) => {
        sidebarWidth.value = clamp(width + (move.clientX - start) / zoom);
      },
      { signal: controller.signal },
    );
    window.addEventListener("pointerup", () => cancel?.(), {
      once: true,
      signal: controller.signal,
    });
    window.addEventListener("blur", () => cancel?.(), {
      once: true,
      signal: controller.signal,
    });
  }
  const refreshWidth = () => {
    if (!cancel) sidebarWidth.value = clamp(Number(localStorage.getItem("pulse_sidebar_width") || 334));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === "pulse_sidebar_width") refreshWidth();
  };
  window.addEventListener("pulse:preferences", refreshWidth);
  window.addEventListener("storage", onStorage);
  onScopeDispose(() => {
    cancel?.();
    window.removeEventListener("pulse:preferences", refreshWidth);
    window.removeEventListener("storage", onStorage);
  });
  return { sidebarWidth, startResize, keyboardResize };
}
