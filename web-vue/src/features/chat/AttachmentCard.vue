<script lang="ts">
const kinds = [
  {
    kind: "document",
    icon: "file",
    label: "文档",
    extensions: /^(pdf|docx?|odt|rtf|txt|pages|pptx?|key)$/,
  },
  {
    kind: "sheet",
    icon: "sheet",
    label: "表格",
    extensions: /^(xlsx?|csv|tsv|ods|numbers)$/,
  },
  {
    kind: "archive",
    icon: "archive",
    label: "压缩包",
    extensions: /^(zip|7z|rar|gz|bz2|xz|tar|tgz)$/,
  },
  {
    kind: "code",
    icon: "code",
    label: "代码",
    extensions:
      /^(md|json|xml|js|ts|jsx|tsx|py|go|rs|java|css|html|sql|ya?ml)$/,
  },
  {
    kind: "image",
    icon: "image",
    label: "图片",
    extensions: /^(png|jpe?g|webp|gif|avif|svg|heic|bmp|tiff?)$/,
  },
  {
    kind: "video",
    icon: "video",
    label: "视频",
    extensions: /^(mp4|mov|webm|mkv|avi|m4v)$/,
  },
  {
    kind: "audio",
    icon: "music",
    label: "音频",
    extensions: /^(mp3|aac|m4a|flac|wav|ogg|opus)$/,
  },
] as const;
const generic = { kind: "file", icon: "file", label: "文件" } as const;
const unit = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${unit.format(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${unit.format(bytes / 1024 ** 2)} MB`;
  return `${unit.format(bytes / 1024 ** 3)} GB`;
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "../../components/UiIcon.vue";

const props = defineProps<{
  filename: string;
  mime?: string;
  bytes?: number;
  layout: "composer" | "message";
}>();

const details = computed(() => {
  const extension =
    /\.([a-z0-9]{1,10})$/i.exec(props.filename)?.[1]?.toLowerCase() || "";
  const mediaType = props.mime?.toLowerCase().split("/", 1)[0];
  const format =
    kinds.find((entry) => entry.kind === mediaType) ??
    kinds.find((entry) => entry.extensions.test(extension)) ??
    generic;
  const bytes = props.bytes;
  return {
    format,
    type: [extension.toUpperCase(), format.label].filter(Boolean).join(" "),
    size:
      bytes != null && Number.isFinite(bytes) && bytes >= 0
        ? fileSize(bytes)
        : "大小未知",
  };
});
</script>

<template>
  <span
    class="attachment-card"
    :data-layout="layout"
    :data-file-kind="details.format.kind"
  >
    <span class="attachment-icon"><UiIcon :name="details.format.icon" /></span>
    <span class="attachment-label">
      <strong :title="filename">{{ filename }}</strong>
      <small>{{ details.type }} · {{ details.size }}</small>
    </span>
    <slot />
  </span>
</template>

<style scoped>
.attachment-card {
  display: flex;
  width: min(var(--attachment-width), 100%);
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border: 1px solid var(--ui-line);
  border-radius: 8px;
  background: var(--ui-surface-soft);
  text-align: start;
  --attachment-width: 224px;
}
.attachment-card[data-layout="message"] {
  --attachment-width: 100%;
  gap: clamp(7px, 2vw, 11px);
  padding: clamp(7px, 2vw, 11px);
  border-radius: 10px;
  background: var(--ui-surface);
}
.attachment-icon {
  display: grid;
  flex: 0 0 36px;
  place-items: center;
  block-size: 36px;
  border-radius: 7px;
  background: var(--art-active-color);
  color: var(--ui-primary);
  font-size: 20px;
}
.attachment-card[data-layout="message"] .attachment-icon {
  flex-basis: 38px;
  block-size: 38px;
}
.attachment-card[data-file-kind="archive"] .attachment-icon {
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
}
.attachment-card[data-file-kind="sheet"] .attachment-icon {
  background: var(--ui-success-soft);
  color: var(--ui-success);
}
.attachment-label {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 3px;
  line-height: 1.4;
}
.attachment-label > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attachment-label strong {
  color: var(--ui-text);
  font-size: var(--ui-font-secondary);
  font-weight: 600;
}
.attachment-label small {
  color: var(--ui-muted);
  font-size: var(--ui-font-caption);
}
.attachment-card[data-layout="message"] .attachment-label strong {
  display: -webkit-box;
  overflow-wrap: anywhere;
  white-space: normal;
  font-size: var(--ui-font-control);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.attachment-card[data-layout="message"] .attachment-label small {
  font-size: var(--ui-font-secondary);
}
</style>
