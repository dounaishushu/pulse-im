import { onScopeDispose, type Ref } from "vue";
import platform from "virtual:pulse-platform";
import type { Chat } from "../../composables/useChat";

export function useDesktopChatShortcuts(chat: Chat, workspace: Readonly<Ref<HTMLElement | null>>) {
  if (platform.name !== "pc") return;
  const lifetime = new AbortController();
  const localOverlay = [
    "[aria-modal='true']", "[role='menu']", ":popover-open", ".vue-side-menu",
    ".vue-emoji-picker", ".vue-mention-picker", ".composer-send-mode[open]",
  ].join(", ");
  function shortcuts(event: KeyboardEvent) {
    const root = workspace.value;
    if (!root || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      chat.locked.value || !chat.foreground.value || chat.interactionBusy.value ||
      document.hidden || document.fullscreenElement || chat.panel.value !== "none") return;
    const key = event.key.toLowerCase();
    const searchShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    const arrow = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown");
    const tab = event.ctrlKey && !event.altKey && !event.metaKey && event.key === "Tab";
    if (event.key !== "Escape" && !arrow && !tab && !(searchShortcut && (key === "f" || key === "k"))) return;
    if ([...document.querySelectorAll(localOverlay)].some((node) => node.getClientRects().length > 0)) return;
    const current = chat.active.value;
    if (searchShortcut && key === "k") {
      const field = root.querySelector<HTMLInputElement>(".sidebar-search input");
      if (!field || !field.getClientRects().length) return;
      event.preventDefault();
      if (!event.repeat) field.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Escape" && current && current.type !== "favorites" &&
      !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
      !chat.selection.value.length) {
      event.preventDefault();
      event.stopPropagation();
      if (platform.windowKind === "conversation") {
        void platform.chatWindows?.close().catch(() => {});
        return;
      }
      chat.closeConversation();
      root.querySelector<HTMLInputElement>('.sidebar-search input')?.focus({ preventScroll: true });
      return;
    }
    if (searchShortcut && key === "f" && current) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) chat.panel.value = "search";
      return;
    }
    if (!arrow && !tab) return;
    // Follow the rendered order, including current filters and collapsed folders.
    const rows = [...root.querySelectorAll<HTMLButtonElement>("[data-conversation-id]")]
      .filter(node => node.getClientRects().length > 0 && !node.disabled);
    if (!rows.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const direction = event.key === "ArrowUp" || (tab && event.shiftKey) ? -1 : 1;
    const index = current ? rows.findIndex(node => node.dataset.conversationId === String(current.id)) : -1;
    const next = index < 0 ? (direction > 0 ? 0 : rows.length - 1) :
      Math.max(0, Math.min(rows.length - 1, index + direction));
    const selected = rows[next];
    if (!selected || next === index) return;
    selected.scrollIntoView({ block: "nearest" });
    selected.click();
  }
  // Ctrl+K changes focus even when the message editor handles its own keys.
  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)) shortcuts(event);
  }, { capture: true, signal: lifetime.signal });
  // Other shortcuts let the editor, popovers and menus handle their keys first.
  window.addEventListener("keydown", shortcuts, { signal: lifetime.signal });
  onScopeDispose(() => lifetime.abort());
}
