<script setup lang="ts">
import type { DesktopArchiveWindow } from "../../platform/contracts";
import ArchiveHistory from "./ArchiveHistory.vue";
import ArchiveImage from "./ArchiveImage.vue";

defineProps<{ kind: "history" | "image"; archive: DesktopArchiveWindow }>();
</script>

<template>
  <div class="archive-shell">
    <ArchiveHistory v-if="kind === 'history'" :archive="archive" />
    <ArchiveImage v-else :archive="archive" />
  </div>
</template>

<style>
body:has(.archive-shell) {
  margin: 0;
  overflow: hidden;
}
.archive-shell {
  --ui-surface: #fff;
  --ui-surface-soft: #f6f8fa;
  --ui-line: #e0e6ed;
  --ui-text: #192230;
  --ui-muted: #596674;
  --ui-primary: #1768cf;
  --ui-outgoing: #e4effd;
  --ui-fill: #eef1f5;
  --ui-focus: #237ce8;
  --ui-danger: #b83240;
  --ui-font-control: 0.8125rem;
  --ui-font-secondary: 0.75rem;
  --ui-font-caption: 0.6875rem;
  --ui-line-content: 1.55;
  --ui-line-heading: 1.35;
  --ui-weight-strong: 600;
  --art-hover-color: #e9eff7;
  height: 100dvh;
  color: var(--ui-text);
  background: var(--ui-surface);
  font: 14px/1.45 "Segoe UI", "Microsoft YaHei UI", sans-serif;
}
.archive-shell:has([data-theme="night"]) {
  --ui-surface: #22252b;
  --ui-surface-soft: #191c21;
  --ui-line: #373c45;
  --ui-text: #ebeff6;
  --ui-muted: #b2bcc8;
  --ui-primary: #a4cdff;
  --ui-outgoing: #293f5c;
  --ui-fill: #30353e;
  --ui-focus: #82baff;
  --ui-danger: #ffa8ae;
  --art-hover-color: #353d48;
  color-scheme: dark;
}
.archive-shell *, .archive-shell *::before, .archive-shell *::after { box-sizing: border-box; }
.archive-shell h1, .archive-shell p { margin: 0; }
.archive-shell button {
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.archive-shell button:not(:disabled):hover { background: var(--art-hover-color); }
.archive-shell button:disabled { opacity: .55; cursor: default; }
.archive-shell :focus-visible { outline: 2px solid var(--ui-focus); outline-offset: 2px; }
.archive-shell .ui-icon { display: inline-flex; align-items: center; }
.archive-shell .ui-icon svg { width: 1em; height: 1em; }
</style>
