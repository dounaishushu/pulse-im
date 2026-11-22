import { computed, onScopeDispose, shallowRef, watch } from "vue";
import { messageOf } from "../../api/client";
import type { Chat } from "../../composables/useChat";

export type TargetKind = "friend" | "group";
interface Recipient {
  id: string;
  display_name: string;
  name: string;
  username: string;
  avatar_id?: string;
  public_id?: string;
}
interface TargetsPage {
  items: Recipient[];
  snapshot_max_id: string;
  next_after_id: string;
  has_more: boolean;
  max_recipients?: number;
}
interface BatchItem { batch_status: string; status: string; total: number }
interface BatchProgress { status: string; total: number; sent: number }
interface Attachment { id: string; file: File; kind: "image" | "video"; mediaId?: string }
const legacyRecipientLimit = 100;
const pictures = /\.(?:jpe?g|png|gif|webp)$/i;
const videos = /\.(?:mp4|webm|mov|avi|mkv|ogv|mpeg|mpg|3gp|m4v|wmv)$/i;
const batchLabels: Record<string, string> = {
  pending: "等待发送", running: "发送中", completed: "已完成", partial: "部分失败", cancelled: "已取消",
};

export function useBroadcastTask(chat: Chat) {
  const client = chat.client;
  const token = client.token;
  const storageKey = "pulse_vue_broadcast:" + chat.me.value?.id;
  const batch = shallowRef(localStorage.getItem(storageKey) || "");
  const kind = shallowRef<TargetKind>("friend");
  const search = shallowRef("");
  const targets = shallowRef<Recipient[]>([]);
  const targetError = shallowRef("");
  const searching = shallowRef(false);
  const more = shallowRef(false);
  const counts = shallowRef<Partial<Record<TargetKind, string>>>({});
  const selecting = shallowRef(false);
  const selected = shallowRef(new Map<string, TargetKind>());
  const recipientLimit = shallowRef(legacyRecipientLimit);
  const body = shallowRef("");
  const files = shallowRef<Attachment[]>([]);
  const busy = shallowRef(false);
  const queued = shallowRef(false);
  const taskState = shallowRef("");
  const taskProgress = shallowRef("");
  const error = shallowRef("");
  const lifetime = new AbortController();
  const current = () => !lifetime.signal.aborted && !chat.locked.value &&
    !chat.updateSuspended.value && chat.me.value?.internal_staff === true && client.token === token;
  let targetRequest: AbortController | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshot = "";
  let after = "";
  let reading = false;
  let requestId = "";
  let conversationIds: string[] | undefined;
  const canCreate = computed(() => current() && !busy.value && !selecting.value && !queued.value && selected.value.size > 0 && selected.value.size <= recipientLimit.value &&
    (!!body.value.trim() || !!files.value.length));
  const allSelected = computed(() => !more.value && !searching.value && targets.value.length > 0 &&
    targets.value.every(row => selected.value.has(row.id)));
  watch([body, files, selected], () => { requestId = ""; conversationIds = undefined; }, { flush: "sync" });

  async function load(append = false) {
    if (!current() || (append && (!after || searching.value))) return false;
    targetRequest?.abort();
    const request = new AbortController();
    targetRequest = request;
    searching.value = true;
    targetError.value = "";
    const params = new URLSearchParams({ kind: kind.value, q: search.value.trim(), limit: "60" });
    if (append) { params.set("snapshot", snapshot); params.set("after", after); }
    try {
      const next = await client.raw<TargetsPage>("/broadcast-targets?" + params, {
        signal: AbortSignal.any([lifetime.signal, request.signal, AbortSignal.timeout(10000)]),
      });
      if (!current() || request.signal.aborted || targetRequest !== request) return false;
      if (next.has_more && (!next.next_after_id || next.next_after_id === (append ? after : "")))
        throw new Error("接收者列表加载不完整，请重试。");
      targets.value = [...new Map((append ? [...targets.value, ...next.items] : next.items).map(row => [row.id, row])).values()];
      const limit = next.max_recipients;
      recipientLimit.value = limit && Number.isSafeInteger(limit) && limit > 0 ? limit : legacyRecipientLimit;
      snapshot = next.snapshot_max_id;
      after = next.next_after_id;
      more.value = next.has_more && !!after;
      if (!search.value.trim()) counts.value = { ...counts.value, [kind.value]: `${targets.value.length}${more.value ? "+" : ""}` };
      return true;
    } catch (cause) {
      if (current() && !request.signal.aborted && targetRequest === request) targetError.value = messageOf(cause);
    } finally {
      if (targetRequest === request) searching.value = false;
    }
    return false;
  }
  watch([kind, search], (_, previous) => {
    clearTimeout(searchTimer);
    targetRequest?.abort();
    targets.value = [];
    more.value = false;
    targetError.value = "";
    searching.value = true;
    if (!previous || kind.value !== previous[0] || !search.value) void load();
    else searchTimer = setTimeout(() => { void load(); }, 220);
  }, { immediate: true, flush: "sync" });

  function choose(rows: Recipient[], checked: boolean) {
    if (!current() || busy.value) return;
    const next = new Map(selected.value);
    for (const { id } of rows) {
      if (checked) next.set(id, kind.value);
      else next.delete(id);
    }
    if (checked && next.size > recipientLimit.value) {
      error.value = `每个群发任务最多可选 ${recipientLimit.value} 个接收者。`;
      return;
    }
    error.value = "";
    selected.value = next;
  }
  async function chooseAll(checked: boolean) {
    if (!current() || busy.value || selecting.value || searching.value || !targets.value.length) return;
    if (!checked) { choose(targets.value, false); return; }
    selecting.value = true;
    const originKind = kind.value, originSearch = search.value;
    const sameList = () => current() && kind.value === originKind && search.value === originSearch;
    try {
      // Include later pages without partially changing an over-limit selection.
      while (sameList()) {
        const combined = new Set([...selected.value.keys(), ...targets.value.map(row => row.id)]);
        if (combined.size > recipientLimit.value) {
          error.value = `每个群发任务最多可选 ${recipientLimit.value} 个接收者，请缩小搜索范围或逐个勾选。`;
          return;
        }
        if (!more.value) { choose(targets.value, true); return; }
        if (!await load(true)) return;
      }
    } finally { selecting.value = false; }
  }
  function addFiles(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (!current() || busy.value) { input.value = ""; return; }
    const next = [...files.value];
    error.value = "";
    for (const file of Array.from(input.files || [])) {
      if (next.length >= 10) { error.value = "每次最多添加 10 个附件。"; break; }
      const kind = pictures.test(file.name) ? "image" : videos.test(file.name) ? "video" : undefined;
      if (!kind || !file.size || file.size > (kind === "image" ? 10 : 100) * 1024 ** 2) {
        error.value = "请选择支持的图片或视频。图片最大 10 MB，视频最大 100 MB。";
        continue;
      }
      next.push({ id: crypto.randomUUID(), file, kind });
    }
    input.value = "";
    files.value = next;
  }
  function removeFile(file: File) {
    if (current() && !busy.value) files.value = files.value.filter((entry) => entry.file !== file);
  }
  function signal() { return AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]); }

  async function check() {
    const id = batch.value;
    if (!id || !current() || reading) return;
    reading = true;
    clearTimeout(pollTimer);
    try {
      const path = `/send-batches/${encodeURIComponent(id)}`;
      const firstPage = await client.raw<BatchProgress | { items: BatchItem[] }>(`${path}?summary=1&size=100`, { signal: signal() });
      if (!current() || id !== batch.value) return;
      let phase: string;
      let sent: number;
      let total: number;
      if ("items" in firstPage) {
        // Older Go versions return the first page even when a summary is requested.
        phase = firstPage.items[0]?.batch_status || "";
        total = firstPage.items[0]?.total || 0;
        sent = firstPage.items.filter((item) => item.status === "sent").length;
        for (let page = 2; (page - 1) * 100 < total && page <= 11; page++) {
          const result = await client.raw<{ items: BatchItem[] }>(`${path}?page=${page}&size=100`, { signal: signal() });
          if (!current() || id !== batch.value) return;
          sent += result.items.filter((item) => item.status === "sent").length;
        }
      } else {
        ({ status: phase, sent, total } = firstPage);
      }
      taskState.value = phase;
      taskProgress.value = phase ? `${batchLabels[phase] || phase} · ${sent}/${total}` : "未找到这次群发任务";
      queued.value = phase === "pending" || phase === "running";
    } catch (cause) {
      if (current()) error.value = messageOf(cause);
    } finally {
      reading = false;
      if (current() && queued.value) pollTimer = setTimeout(() => { void check(); }, 3500);
    }
  }
  async function send() {
    if (!current() || !canCreate.value) return;
    busy.value = true;
    error.value = "";
    requestId ||= "broadcast-" + crypto.randomUUID();
    try {
      const attachments: { id: string; kind: Attachment["kind"] }[] = [];
      for (const [index, item] of files.value.entries()) {
        if (!current()) return;
        taskProgress.value = `正在上传附件 ${index + 1}/${files.value.length}`;
        item.mediaId ||= (await client.uploadMedia(item.kind, item.file, { signal: lifetime.signal })).id;
        attachments.push({ id: item.mediaId, kind: item.kind });
      }
      if (!conversationIds) {
        const rows: string[] = [];
        for (const [id, type] of selected.value) {
          if (!current()) return;
          if (type === "group") rows.push(id);
          else {
            taskProgress.value = `正在准备接收者 ${rows.length + 1}/${selected.value.size}`;
            const target = await client.raw<{ id: string }>("/conversations/direct", {
              method: "POST", body: { peer_id: id }, signal: signal(),
            });
            rows.push(target.id);
          }
        }
        conversationIds = [...new Set(rows)];
      }
      if (!current()) return;
      const accepted = await client.raw<{ id: string }>("/broadcasts", {
        method: "POST", signal: signal(),
        body: { request_id: requestId, conversation_ids: conversationIds, body: body.value.trim(), attachments },
      });
      // Keep the server's job ID even if its window goes away after admission.
      try { localStorage.setItem(storageKey, accepted.id); } catch { /* The current session can still show the task. */ }
      if (!current()) return;
      batch.value = accepted.id;
      queued.value = true;
      taskState.value = "pending";
      taskProgress.value = "任务已提交";
      body.value = "";
      selected.value = new Map();
      files.value = [];
      void check();
    } catch (cause) {
      if (current()) error.value = messageOf(cause);
    } finally {
      busy.value = false;
    }
  }
  async function control(action: "retry" | "cancel") {
    if (!current() || !batch.value || busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      await client.raw("/send-batches/" + encodeURIComponent(batch.value) + (action === "retry" ? "/retry" : ""), {
        method: action === "retry" ? "POST" : "DELETE",
        body: action === "retry" ? {} : undefined,
        signal: signal(),
      });
      await check();
    } catch (cause) {
      if (current()) error.value = messageOf(cause);
    } finally {
      busy.value = false;
    }
  }
  if (batch.value) void check();
  onScopeDispose(() => {
    clearTimeout(searchTimer);
    clearTimeout(pollTimer);
    targetRequest?.abort();
    lifetime.abort();
  });
  return { batch, kind, search, targets, targetError, searching, more, counts, selecting, allSelected, selected, body, files, busy, canCreate,
    taskState, taskProgress, error, addFiles, removeFile, load, choose, chooseAll, check, send, control };
}
