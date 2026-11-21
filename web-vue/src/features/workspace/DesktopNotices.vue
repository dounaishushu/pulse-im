<script setup lang="ts">
import { onMounted, onScopeDispose, shallowRef } from "vue";
import platform from "virtual:pulse-platform";
import UiIcon from "../../components/UiIcon.vue";
import type { NoticeAction, NoticeView } from "../../platform/contracts";

const notices = platform.noticeWindow!;
const rows = shallowRef<NoticeView[]>([]);
let stopListening: (() => void) | undefined;
let active = true;
let sequence = 0;
async function reload() {
  const mine = ++sequence;
  const result = await notices.snapshot();
  if (active && mine === sequence) rows.value = result;
}
function act(id: string, action: NoticeAction) {
  void notices.act(id, action).catch(() => {});
}
onMounted(async () => {
  try {
    const unlisten = await notices.subscribe(() => { void reload().catch(() => {}); });
    if (!active) { unlisten(); return; }
    stopListening = unlisten;
    await reload();
    if (active) await notices.ready();
  } catch { /* A pending notification expires when the window is unavailable. */ }
});
onScopeDispose(() => { active = false; stopListening?.(); });
</script>

<template>
  <main class="notice-stack" aria-label="新消息">
    <article v-for="row in rows" :key="row.id" class="notice" @mouseenter="act(row.id, 'hover')" @mouseleave="act(row.id, 'leave')">
      <button type="button" class="notice-content" :aria-label="row.title + '，' + row.body + '，打开会话'" @click="act(row.id, 'open')">
        <strong>{{ row.title }}</strong>
        <span>{{ row.body }}</span>
      </button>
      <div class="notice-controls">
        <button type="button" class="dismiss" aria-label="关闭提醒" @click="act(row.id, 'close')"><UiIcon name="close" /></button>
        <button type="button" class="reply" @click="act(row.id, 'reply')">回复</button>
      </div>
    </article>
  </main>
</template>

<style>
html, body, #app { margin: 0; overflow: hidden; }
</style>

<style scoped>
.notice-stack {
  font: 13px/1.35 "Microsoft YaHei UI", "Segoe UI", sans-serif;
  color: #192230;
  background: #fff;
}
.notice {
  display: grid;
  box-sizing: border-box;
  height: 94px;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #e3e7ed;
}
.notice-content,
.notice-controls button {
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.notice-content {
  display: grid;
  min-width: 0;
  align-content: center;
  gap: 5px;
  padding: 5px 8px;
  text-align: start;
}
.notice-content:hover,
.notice-controls button:hover { background: #eef4fc; }
.notice-content strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notice-content span {
  display: -webkit-box;
  overflow: hidden;
  color: #596674;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.notice-controls {
  display: grid;
  align-content: space-between;
  justify-items: end;
}
.notice-controls button { min-width: 30px; min-height: 28px; }
.notice-controls .dismiss { color: #596674; }
.notice-controls .reply { padding-inline: 8px; color: #1768cf; font-weight: 600; }
</style>
