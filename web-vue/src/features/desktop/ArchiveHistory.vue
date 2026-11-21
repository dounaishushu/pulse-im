<script lang="ts">
const day = new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeZone: "Asia/Shanghai" });
</script>
<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, shallowRef, useTemplateRef } from "vue";
import UiIcon from "../../components/UiIcon.vue";
import type { ArchiveHistory, ArchiveMessage, ArchiveUpdate, DesktopArchiveWindow } from "../../platform/contracts";
import ArchiveMessageRow from "./ArchiveMessageRow.vue";

const { archive } = defineProps<{ archive: DesktopArchiveWindow }>();
const context = shallowRef<ArchiveHistory>();
const messages = shallowRef<ArchiveMessage[]>([]);
const assets = shallowRef<Record<string, string>>({});
const loading = shallowRef(false);
const loaded = shallowRef(false);
const hasMore = shallowRef(false);
const error = shallowRef("");
const feedback = shallowRef("");
const scroller = useTemplateRef<HTMLElement>("scroller");
const rows = computed(() => {
  let last = "";
  return messages.value.map(row => {
    const date = Date.parse(row.createdAt);
    const label = Number.isFinite(date) ? day.format(date) : "";
    const heading = label !== last ? label : "";
    last = label;
    return { row, heading };
  });
});
let unsubscribe: (() => void) | undefined;
let disposed = false;
let revision = 0;
let refreshQueued = false;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const busyActions = new Set<string>();
const pendingRemovals = new Set<string>();
const reason = (cause: unknown) => typeof cause === "string" ? cause : "暂时无法完成，请重试。";

function bottom() {
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}

async function loadAssets(ids: string[], register = revision) {
  if (!ids.length) return;
  const urls = await archive.assets(ids);
  if (!disposed && register === revision) assets.value = { ...assets.value, ...urls };
}

async function load(older = false) {
  if (loading.value || disposed || (older && !hasMore.value)) return;
  const register = revision;
  loading.value = true;
  error.value = "";
  const viewport = scroller.value;
  const height = viewport?.scrollHeight ?? 0;
  const top = viewport?.scrollTop ?? 0;
  try {
    const page = await archive.page(older);
    if (disposed || register !== revision) return;
    if (!older) assets.value = {};
    const visible = page.items.filter(row => !pendingRemovals.has(row.id));
    messages.value = older ? [...visible, ...messages.value] : visible;
    hasMore.value = page.hasMore;
    loaded.value = true;
    const unresolved = new Set<string>();
    for (const row of visible) {
      if (row.avatar && !assets.value[row.avatar]) unresolved.add(row.avatar);
      if (row.media && row.kind !== "file" && !assets.value[row.media.id]) unresolved.add(row.media.id);
    }
    // The list and its scroll position never wait for thumbnails or avatars.
    void loadAssets([...unresolved], register).catch(() => {});
    await nextTick();
    if (disposed || register !== revision) return;
    if (older && viewport) viewport.scrollTop = top + viewport.scrollHeight - height;
    else bottom();
  } catch (cause) {
    if (!disposed && register === revision) error.value = reason(cause);
  } finally {
    if (!disposed) loading.value = false;
    pendingRemovals.clear();
    if (refreshQueued && !disposed) {
      refreshQueued = false;
      void load();
    }
  }
}

function invalidate(update: ArchiveUpdate) {
  if (!update.reload) {
    const removed = new Set(update.removed);
    if (loading.value) for (const id of removed) pendingRemovals.add(id);
    messages.value = messages.value.filter(row => !removed.has(row.id));
    return;
  }
  revision++;
  messages.value = [];
  assets.value = {};
  hasMore.value = false;
  loaded.value = false;
  error.value = "";
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (loading.value) refreshQueued = true;
    else void load();
  }, 100);
}

async function act(key: string, task: () => Promise<void | boolean>, success = "") {
  if (busyActions.has(key)) return;
  busyActions.add(key);
  try {
    const result = await task();
    if (result !== false && success) report(success);
  } catch (cause) {
    report(reason(cause));
  } finally {
    busyActions.delete(key);
  }
}

function report(text: string) {
  if (disposed) return;
  clearTimeout(feedbackTimer);
  feedback.value = text;
  feedbackTimer = setTimeout(() => { feedback.value = ""; }, 3500);
}

function keyboard(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing) return;
  event.preventDefault();
  void archive.close().catch(() => {});
}

onMounted(async () => {
  window.addEventListener("keydown", keyboard);
  try {
    const release = await archive.onHistoryChange(invalidate);
    if (disposed) { release(); return; }
    unsubscribe = release;
    context.value = await archive.history();
    if (!disposed) await load();
  } catch (cause) {
    if (!disposed) error.value = reason(cause);
  }
});
onScopeDispose(() => {
  disposed = true;
  clearTimeout(feedbackTimer);
  clearTimeout(refreshTimer);
  window.removeEventListener("keydown", keyboard);
  unsubscribe?.();
});
</script>

<template>
  <section class="archive-history" :data-theme="context?.theme">
    <header class="history-head">
      <div>
        <h1>{{ context?.title || "聊天记录" }}</h1>
        <p v-if="context">{{ { group: '群聊', direct: '私聊', channel: '频道', favorites: '收藏' }[context.kind] || '聊天记录' }}</p>
      </div>
      <button type="button" :disabled="loading || !context" @click="load()"><UiIcon name="refresh" /> 刷新记录</button>
    </header>
    <main ref="scroller" class="history-scroll" tabindex="0" aria-label="聊天记录" :aria-busy="loading">
      <div class="history-pager">
        <p v-if="error" role="alert">{{ error }}</p>
        <button v-if="hasMore" type="button" :disabled="loading" @click="load(true)">{{ loading ? "加载中…" : "加载更早记录" }}</button>
        <span v-else-if="loading || (!loaded && !error)" role="status">正在加载…</span>
        <span v-else-if="loaded && messages.length && !error">已到最早记录</span>
      </div>
      <template v-for="{ row, heading } in rows" :key="row.id">
        <div v-if="heading" class="history-day">{{ heading }}</div>
        <ArchiveMessageRow :row="row" :avatar="row.avatar ? assets[row.avatar] : undefined"
          :src="row.media ? assets[row.media.id] : undefined"
          @preview="act('preview', () => archive.preview(row.id))"
          @copy-text="act('copy', () => archive.copyText(row.id), '文字已复制')"
          @copy-image="act('copy', () => archive.copyImage(row.id), '图片已复制')"
          @download="act('download', () => archive.download(row.id), '已加入下载任务')"
          @retry="id => act(id, () => loadAssets([id]))" />
      </template>
      <p v-if="loaded && !messages.length && !loading && !error" class="history-empty" role="status">暂无聊天记录</p>
    </main>
    <footer class="history-footer">
      <span>已加载 {{ messages.length }} 条</span>
      <span class="history-feedback" role="status">{{ feedback }}</span>
      <button type="button" :disabled="!messages.length" @click="bottom">回到底部 <UiIcon name="down" /></button>
    </footer>
  </section>
</template>

<style scoped>
.archive-history { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
.history-head, .history-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 16px; }
.history-head { border-bottom: 1px solid var(--ui-line); }
.history-head > div { min-width: 0; }
.history-head h1 { color: var(--ui-text); font-size: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-head p, .history-footer { color: var(--ui-muted); font-size: 12px; }
.history-head button, .history-footer button { flex: none; display: inline-flex; align-items: center; gap: 6px; color: var(--ui-primary); font-size: 13px; }
.history-scroll { overflow: auto; overflow-anchor: none; padding: 12px 15px 18px; outline-offset: -2px; scrollbar-width: thin; background: var(--ui-surface-soft); }
.history-pager, .history-empty, .history-day { padding: 6px; text-align: center; color: var(--ui-muted); font-size: 12px; }
.history-pager [role="alert"] { color: var(--ui-danger); margin-bottom: 5px; }
.history-pager button { border-color: var(--ui-line); background: var(--ui-surface); color: var(--ui-primary); }
.history-day { padding-top: 13px; }
.history-footer { border-top: 1px solid var(--ui-line); }
.history-feedback { flex: 1; min-width: 0; text-align: center; color: var(--ui-primary); overflow-wrap: anywhere; }
</style>
