<script lang="ts">
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });
</script>
<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import platform from "virtual:pulse-platform";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import AttachmentCard from "../chat/AttachmentCard.vue";
import type { ArchiveMessage } from "../../platform/contracts";

const props = defineProps<{ row: ArchiveMessage; avatar?: string; src?: string }>();
const emit = defineEmits<{
  preview: [];
  copyText: [];
  copyImage: [];
  download: [];
  retry: [id: string];
}>();
const failed = shallowRef(false);
watch(() => props.src, () => { failed.value = false; });
const time = computed(() => {
  const date = Date.parse(props.row.createdAt);
  return Number.isFinite(date) ? clock.format(date) : "";
});
const playable = computed(() => {
  const source = props.src || "";
  return platform.mediaSource ? platform.mediaSource(source) : source;
});
const thumb = computed(() => playable.value.replace(/\/content$/, "/preview"));
const kind = computed(() => props.row.kind);
const previewStyle = computed(() => {
  const width = props.row.media?.width || 260;
  const height = props.row.media?.height || 180;
  return { width: `${Math.min(width, 310, 260 * width / height)}px`, aspectRatio: `${width} / ${height}` };
});
function selectText(event: MouseEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const range = document.createRange();
  const selection = window.getSelection();
  if (!selection) return;
  range.selectNodeContents(event.currentTarget as HTMLElement);
  selection.removeAllRanges();
  selection.addRange(range);
}
</script>

<template>
  <article class="history-entry" :class="{ mine: row.mine }" :data-seq="row.seq">
    <AvatarImage :name="row.name" :src="avatar" />
    <div class="history-content">
      <div class="message-author">
        <strong>{{ row.mine ? "我" : row.name }}</strong>
        <time :datetime="row.createdAt">{{ time }}</time>
      </div>
      <div class="message-content">
        <button v-if="row.media && kind === 'file'" type="button" class="file" @click="emit('download')"
          :aria-label="'下载 ' + row.media.filename">
          <AttachmentCard :filename="row.media.filename" :mime="row.media.mime" :bytes="Number(row.media.bytes)" layout="message" />
          <UiIcon name="download" />
        </button>
        <template v-else-if="row.media && ['image', 'video', 'audio'].includes(kind)">
          <button
            v-if="kind === 'image'"
            type="button"
            class="photo"
            :style="previewStyle"
            :aria-label="row.media.filename || '查看图片'"
            @click="emit('preview')"
          >
            <img v-if="thumb && !failed" :src="thumb" alt="" loading="lazy" decoding="async" @error="failed = true" />
            <span v-else class="photo-fallback"><UiIcon name="image" /> {{ failed ? '加载失败，点击查看' : '查看图片' }}</span>
          </button>
          <video v-else-if="kind === 'video' && playable && !failed" :src="playable" controls preload="none" @error="failed = true" />
          <audio v-else-if="kind === 'audio' && playable && !failed" :src="playable" controls preload="none" @error="failed = true" />
          <button v-else type="button" class="load-media" @click="emit('retry', row.media.id)">
            {{ failed ? '加载失败，点击重试' : '加载附件' }}
          </button>
        </template>
        <div v-else-if="row.contact" class="contact-card">
          <UiIcon name="contactCard" />
          <div><strong>{{ row.contact.nickname }}</strong><small>{{ row.contact.account ? '@' + row.contact.account : '个人名片' }}</small></div>
        </div>
        <p v-if="row.text || (!row.media && !row.contact)" class="message-text" @dblclick="selectText">
          {{ row.text || (kind === 'shake' ? '窗口抖动' : '[消息]') }}
        </p>
      </div>
      <div v-if="row.text || kind === 'image'" class="message-actions">
        <button v-if="row.text" type="button" @click="emit('copyText')">复制文字</button>
        <button v-if="row.media && kind === 'image'" type="button" @click="emit('copyImage')">复制图片</button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.history-entry { display: flex; align-items: flex-start; gap: 10px; min-width: 0; padding-block: 9px 2px; }
.history-entry.mine { flex-direction: row-reverse; }
.history-entry :deep(.avatar) { --avatar-size: 32px; --avatar-radius: 9px; }
.history-content { min-width: 0; display: grid; justify-items: start; }
.mine .history-content { justify-items: end; }
.message-author { display: flex; align-items: baseline; gap: 7px; max-width: 100%; color: var(--ui-muted); font-size: 12px; }
.message-author strong { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-author time { flex: none; font-size: 11px; }
.message-content { display: grid; justify-items: start; gap: 6px; min-width: 0; max-width: 100%; }
.mine .message-content { justify-items: end; }
.message-text, .contact-card, .load-media { min-width: 0; max-width: 100%; padding: 7px 10px; border-radius: 8px; background: var(--ui-fill); }
.message-text {
  font-family: var(--chat-font-family, inherit);
  font-size: var(--chat-font-size, 1em);
  font-weight: var(--chat-font-weight, 400);
  line-height: var(--chat-line-height, 1.6);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mine .message-text { background: var(--ui-outgoing); }
.contact-card { display: flex; gap: 9px; align-items: center; }
.contact-card small { display: block; color: var(--ui-muted); }
button.file, button.photo { min-width: 0; max-width: 100%; padding: 0; border: 0; }
.file { display: inline-flex; align-items: center; gap: 8px; }
.file > .ui-icon { margin-inline-end: 8px; color: var(--ui-primary); }
button.photo { display: grid; place-items: center; overflow: hidden; border-radius: 8px; background: var(--ui-fill); }
.photo img { display: block; width: 100%; height: 100%; object-fit: contain; }
.photo-fallback { display: inline-flex; align-items: center; gap: 6px; padding: 5px; color: var(--ui-muted); font-size: 12px; }
video { display: block; max-width: min(310px, 100%); max-height: 260px; height: auto; border-radius: 8px; }
audio { max-width: 100%; }
.message-actions { display: flex; gap: 4px; }
.message-actions button { padding: 3px 4px; color: var(--ui-muted); font-size: 12px; }
</style>
