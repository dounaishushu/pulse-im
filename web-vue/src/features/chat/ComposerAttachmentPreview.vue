<script setup lang="ts">
import { computed } from "vue";
import {
  IconArchive,
  IconCodeStroked,
  IconFile,
  IconImageStroked,
  IconListView,
  IconMusicNoteStroked,
  IconVideoStroked,
} from "@kousum/semi-icons-vue";
import UiIcon from "../../components/UiIcon.vue";

const props = defineProps<{ file: File }>();
const emit = defineEmits<{ remove: [] }>();
const kinds = [
  {
    kind: "document",
    icon: IconFile,
    label: "文档",
    extensions: /^(pdf|docx?|odt|rtf|txt|pages|pptx?|key)$/,
  },
  {
    kind: "sheet",
    icon: IconListView,
    label: "表格",
    extensions: /^(xlsx?|csv|tsv|ods|numbers)$/,
  },
  {
    kind: "archive",
    icon: IconArchive,
    label: "压缩包",
    extensions: /^(zip|7z|rar|gz|bz2|xz|tar|tgz)$/,
  },
  {
    kind: "code",
    icon: IconCodeStroked,
    label: "代码",
    extensions:
      /^(md|json|xml|js|ts|jsx|tsx|py|go|rs|java|css|html|sql|ya?ml)$/,
  },
  {
    kind: "image",
    icon: IconImageStroked,
    label: "图片",
    extensions: /^(png|jpe?g|webp|gif|avif|svg|heic|bmp|tiff?)$/,
  },
  {
    kind: "video",
    icon: IconVideoStroked,
    label: "视频",
    extensions: /^(mp4|mov|webm|mkv|avi|m4v)$/,
  },
  {
    kind: "audio",
    icon: IconMusicNoteStroked,
    label: "音频",
    extensions: /^(mp3|aac|m4a|flac|wav|ogg|opus)$/,
  },
] as const;
const generic = { kind: "file", icon: IconFile, label: "文件" };
const unit = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${unit.format(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${unit.format(bytes / 1024 ** 2)} MB`;
  return `${unit.format(bytes / 1024 ** 3)} GB`;
}
const attachment = computed(() => {
  const file = props.file;
  const extension =
    /\.([a-z0-9]{1,10})$/i.exec(file.name)?.[1]?.toLowerCase() || "";
  const mediaType = file.type.split("/", 1)[0];
  const format =
    kinds.find((entry) => entry.kind === mediaType) ??
    kinds.find((entry) => entry.extensions.test(extension)) ??
    generic;
  return {
    format,
    type: [extension.toUpperCase(), format.label].filter(Boolean).join(" "),
    size: fileSize(file.size),
  };
});
</script>

<template>
  <span class="composer-file-card" :data-file-kind="attachment.format.kind">
    <span class="composer-file-icon">
      <component :is="attachment.format.icon" aria-hidden="true" />
    </span>
    <span class="composer-file-label">
      <strong :title="file.name">{{ file.name }}</strong>
      <small>{{ attachment.type }} · {{ attachment.size }}</small>
    </span>
    <button
      type="button"
      class="ui-icon-button composer-file-remove"
      :aria-label="`移除 ${file.name}`"
      title="移除附件"
      @mousedown.prevent
      @click="emit('remove')"
    >
      <UiIcon name="close" />
    </button>
  </span>
</template>

<style scoped>
.composer-file-card {
  display: flex;
  width: min(224px, 100%);
  align-items: center;
  gap: 7px;
  padding: 6px;
  border: 1px solid var(--ui-line);
  border-radius: 7px;
  background: var(--ui-surface-soft);
}
.composer-file-icon {
  display: grid;
  flex: 0 0 36px;
  place-items: center;
  block-size: 36px;
  border-radius: 6px;
  background: var(--art-active-color);
  color: var(--ui-primary);
  font-size: 20px;
}
.composer-file-icon .semi-icon {
  font-size: inherit;
}
.composer-file-card[data-file-kind="archive"] .composer-file-icon {
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
}
.composer-file-card[data-file-kind="sheet"] .composer-file-icon {
  background: var(--ui-success-soft);
  color: var(--ui-success);
}
.composer-file-label {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 3px;
}
.composer-file-label > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.composer-file-label strong {
  color: var(--ui-text);
  font-size: 12px;
  font-weight: 600;
}
.composer-file-label small {
  color: var(--ui-muted);
  font-size: 11px;
}
.composer-file-remove {
  width: 26px;
  height: 26px;
  font-size: 14px;
}
</style>
