import platform from "virtual:pulse-platform";
import { bindDesktopChatTypography } from "./composables/chatTypography";

function observeWorkspace() {
  const diagnostics = platform.diagnostics;
  if (!diagnostics) return;
  diagnostics.report("workspaceMounted", Math.round(performance.now()));
  const lifetime = new AbortController();
  const reportError = () => diagnostics.report("rendererError");
  window.addEventListener("error", reportError, { signal: lifetime.signal });
  window.addEventListener("unhandledrejection", reportError, { signal: lifetime.signal });
  let observer: PerformanceObserver | undefined;
  if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    observer = new PerformanceObserver((list) => {
      if (document.hidden) return;
      const longest = list.getEntries().reduce((ms, item) => Math.max(ms, item.duration), 0);
      if (longest >= 120) diagnostics.report("rendererLongTask", Math.round(longest));
    });
    observer.observe({ entryTypes: ["longtask"] });
  }
  window.addEventListener("pagehide", () => {
    observer?.disconnect();
    lifetime.abort();
  }, { once: true });
}

function bindLogShortcut() {
  if (platform.windowKind !== "workspace" && platform.windowKind !== "conversation") return;
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.repeat || !event.ctrlKey || !event.shiftKey ||
      event.altKey || event.metaKey || event.key.toLowerCase() !== "l") return;
    event.preventDefault();
    void platform.diagnostics?.openLogs().catch(() => {});
  });
}

async function mount() {
  await platform.initialize();
  bindLogShortcut();
  if (platform.windowKind === "workspace" || platform.windowKind === "history" || platform.windowKind === "conversation") {
    void bindDesktopChatTypography();
  }
  if (platform.windowKind === "screenshot") {
    const [{ createApp }, { default: ScreenshotOverlay }] = await Promise.all([
      import("vue"),
      import("./features/desktop/ScreenshotOverlay.vue"),
    ]);
    createApp(ScreenshotOverlay, { overlay: platform.screenshotOverlay! }).mount("#app");
    return;
  }
  if (platform.windowKind === "history" || platform.windowKind === "image") {
    const [{ createApp }, { default: Archive }] = await Promise.all([
      import("vue"),
      import("./features/desktop/ArchiveShell.vue"),
    ]);
    createApp(Archive, { kind: platform.windowKind, archive: platform.archiveWindow! }).mount("#app");
    return;
  }
  if (platform.windowKind === "conversation") {
    const [{ createApp }, { default: App }, conversation] = await Promise.all([
      import("vue"), import("./App.vue"), platform.chatWindows!.context(),
    ]);
    createApp(App, { conversation }).mount("#app");
    observeWorkspace();
    return;
  }
  if (platform.windowKind === "notification") {
    const [{ createApp }, { default: Notifications }] = await Promise.all([
      import("vue"),
      import("./features/workspace/DesktopNotices.vue"),
    ]);
    createApp(Notifications).mount("#app");
    return;
  }
  await import("./main");
  observeWorkspace();
}

void mount().catch(() => {
  const root = document.getElementById("app");
  if (!root) return;
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = "客户端启动失败，请退出后重新打开。";
  root.replaceChildren(message);
});
