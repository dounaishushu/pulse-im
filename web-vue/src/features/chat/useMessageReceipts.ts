import { nextTick, onScopeDispose, shallowRef, watch, type Ref } from "vue";
import type { Chat } from "../../composables/useChat";
import type { Message } from "../../api/types";

interface Receipt {
  message_id: string;
  read_count: number;
  delivered_count: number;
  recipient_count: number;
}
interface ReceiptPage {
  items: Receipt[];
}

export function useMessageReceipts(chat: Chat, area: Readonly<Ref<HTMLElement | null>>, messages: Readonly<Ref<Message[]>>) {
  const cache = shallowRef(new Map<number, { count: number; revision: number }>());
  const failed = shallowRef(new Set<number>());
  const lifetime = new AbortController();
  let owner = "", revision = 0, disposed = false, queued = false, nextFetch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: AbortController | undefined;
  const key = () => JSON.stringify([
    chat.client.base, chat.client.token, chat.me.value?.id, chat.active.value?.id,
    chat.active.value?.type, chat.active.value?.membership_version, chat.openRevision.value,
  ]);
  const available = () => !disposed && !document.hidden && chat.foreground.value &&
    !chat.locked.value && !chat.updateSuspended.value && !chat.loading.value && !chat.openingError.value &&
    !!chat.client.token && !!chat.me.value && !!area.value?.isConnected &&
    ["direct", "group"].includes(chat.active.value?.type || "");
  function eligible(message: Message) {
    return !chat.locked.value && ["direct", "group"].includes(chat.active.value?.type || "") &&
      message.conversation_id === chat.active.value?.id && message.sender_id === chat.me.value?.id &&
      Number.isSafeInteger(message.id) && message.id > 0 && typeof message.body._go_wire_id === "string" && !!message.body._go_wire_id &&
      !message.recalled_at && !["recalled", "deleted", "sending", "failed"].includes(message.status || "") &&
      !["system", "red_packet"].includes(message.type);
  }
  function reset() {
    clearTimeout(timer); timer = undefined; flight?.abort(); flight = undefined; queued = false;
    owner = key(); revision++; nextFetch = 0; cache.value = new Map(); failed.value = new Set();
  }
  function label(message: Message) {
    const count = cache.value.get(message.id)?.count;
    if (count === undefined) return failed.value.has(message.id) ? "待确认" : "…";
    return chat.active.value?.type === "group" ? `${count}人已读` : count > 0 ? "已读" : "未读";
  }
  function title(message: Message) {
    if (failed.value.has(message.id)) return "暂时无法刷新阅读状态，稍后重试";
    const count = cache.value.get(message.id)?.count;
    return count === undefined ? "正在获取阅读状态" : chat.active.value?.type === "group"
      ? `${count} 位成员已读` : count > 0 ? "对方已读" : "对方尚未读";
  }
  function refresh() {
    if (disposed) return;
    if (owner !== key()) reset();
    if (!available()) { clearTimeout(timer); timer = undefined; flight?.abort(); flight = undefined; queued = false; return; }
    if (flight) { queued = true; return; }
    // Large groups can emit many receipt hints while members scroll.
    // Retain a scheduled refresh so continuous hints cannot postpone it forever.
    if (timer === undefined) timer = setTimeout(() => void poll(), Math.max(120, nextFetch - Date.now()));
  }
  async function poll() {
    timer = undefined;
    if (!available() || flight) return;
    const host = area.value!, conversation = chat.active.value!, target = owner;
    const current = () => available() && key() === target && owner === target && area.value === host;
    const box = host.getBoundingClientRect();
    if (!box.height || !box.width) return;
    const own = new Map(messages.value.filter(eligible).map(message => [message.id, message.body._go_wire_id!]));
    const ids = [...new Set([...host.querySelectorAll<HTMLElement>("[data-message-receipt]")]
      .filter(node => { const bounds = node.getBoundingClientRect(); return bounds.bottom > box.top && bounds.top < box.bottom; })
      .map(node => Number(node.dataset.messageReceipt)))].filter(id => {
      const previous = cache.value.get(id);
      return own.has(id) && !(conversation.type === "direct" && (previous?.count || 0) > 0) && previous?.revision !== revision;
    });
    if (!ids.length || !current()) return;
    const controller = new AbortController(), stamp = revision, token = chat.client.token;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    flight = controller; queued = false; nextFetch = Date.now() + 1000;
    try {
      // A viewport is fetched in bounded batches, never one request per message.
      for (let offset = 0; offset < ids.length && current(); offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const selected = new Map(batch.map(id => [own.get(id)!.toLowerCase(), id]));
        if (selected.size !== batch.length || [...selected.keys()].some(id =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) throw Error("消息标识无效");
        // The visible rows already carry wire UUIDs. Do not reload evicted
        // message bodies or conversation details just to map receipt IDs.
        const wire = chat.client.wire("conversation", conversation.id);
        const result = await chat.client.raw<ReceiptPage>(`/conversations/${wire}/message-receipts`, {
          method: "POST", body: { message_ids: [...selected.keys()] }, authToken: token, signal,
        });
        if (!current() || signal.aborted) return;
        // Apply this verified snapshot even when a newer hint has arrived;
        // otherwise busy groups could postpone all visible updates indefinitely.
        if (stamp !== revision) queued = true;
        if (!Array.isArray(result.items) || result.items.length !== batch.length) throw Error("阅读回执范围无效");
        const seen = new Set<string>();
        for (const item of result.items) {
          if (!selected.has(item.message_id) || seen.has(item.message_id) ||
              ![item.read_count, item.delivered_count, item.recipient_count].every(n => Number.isSafeInteger(n) && n >= 0) ||
              item.read_count > item.delivered_count || item.delivered_count > item.recipient_count) throw Error("阅读回执数据无效");
          seen.add(item.message_id);
        }
        const next = new Map(cache.value), errors = new Set(failed.value);
        for (const item of result.items) {
          const id = selected.get(item.message_id)!;
          next.set(id, { count: item.read_count, revision: stamp }); errors.delete(id);
        }
        while (next.size > 2000) next.delete(next.keys().next().value!);
        cache.value = next; failed.value = errors;
      }
    } catch (cause) {
      if (current() && !controller.signal.aborted) {
        const errors = new Set([...failed.value, ...ids]);
        while (errors.size > 2000) errors.delete(errors.values().next().value!);
        failed.value = errors;
        if ([401, 426].includes((cause as { status?: number }).status || 0)) chat.error(cause);
      }
    } finally {
      if (flight === controller) {
        flight = undefined;
        if (queued && current()) { queued = false; refresh(); }
      }
    }
  }
  watch(key, () => { reset(); refresh(); }, { flush: "post" });
  watch([messages, area, chat.loading, chat.openingError, chat.updateSuspended],
    () => { void nextTick(refresh); }, { flush: "post" });
  watch([chat.locked, chat.foreground], ([locked, foreground], [wasLocked, wasForeground]) => {
    if (!locked && foreground && (wasLocked || !wasForeground)) revision++;
    refresh();
  }, { flush: "post" });
  watch(chat.receiptRevision, () => { revision++; refresh(); });
  const resume = () => { revision++; refresh(); };
  window.addEventListener("focus", resume, { signal: lifetime.signal });
  window.addEventListener("online", resume, { signal: lifetime.signal });
  document.addEventListener("visibilitychange", resume, { signal: lifetime.signal });
  onScopeDispose(() => { disposed = true; lifetime.abort(); clearTimeout(timer); flight?.abort(); });
  return { eligible, label, title, isRead: (message: Message) => (cache.value.get(message.id)?.count || 0) > 0, refresh };
}
