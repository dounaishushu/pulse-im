<script setup lang="ts">
import { computed, inject, onScopeDispose, shallowRef } from "vue";
import platform from "virtual:pulse-platform";
import UiIcon from "../../components/UiIcon.vue";
import { chatKey } from "../../composables/useChat";
import type { Message } from "../../api/types";
import AttachmentCard from "./AttachmentCard.vue";

const props = defineProps<{ message: Message }>();
const { client, locked } = inject(chatKey)!;
const mediaId = computed(() => props.message.body._go_media_id);
const filename = computed(() => props.message.body.name || "附件");
const bytes = computed(() => {
  const size = props.message.body.size;
  return size && size > 0 ? size : undefined;
});
const legacyLink = computed(() => {
  if (mediaId.value || !props.message.body.url) return "";
  try {
    const target = new URL(props.message.body.url, location.href);
    if (target.protocol === "https:" || target.protocol === "http:") return target.href;
  } catch {
    // Older messages can have incomplete attachment metadata.
  }
  return "";
});

const busy = shallowRef(false);
const feedback = shallowRef("");
const request = new AbortController();

async function download() {
  const id = mediaId.value;
  const token = client.token;
  const stillCurrent = () => !request.signal.aborted && !locked.value && client.token === token;
  if (!id || !token || busy.value || !stillCurrent()) return;
  busy.value = true;
  feedback.value = "";
  try {
    if (platform.downloads) {
      const task = await platform.downloads.start({
        mediaId: id,
        name: filename.value,
        token,
      });
      if (task && stillCurrent()) feedback.value = "已加入下载任务";
      return;
    }
    const url = await client.mediaGrant(id, token, request.signal);
    if (!stillCurrent()) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = filename.value;
    link.rel = "noreferrer";
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  } catch (cause) {
    if (stillCurrent()) {
      feedback.value =
        typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "下载失败，请点击附件重试。";
    }
  } finally {
    busy.value = false;
  }
}

onScopeDispose(() => request.abort());
</script>

<template>
  <div class="message-file">
    <component
      :is="legacyLink ? 'a' : 'button'"
      class="message-file-action"
      :class="{ 'can-download': mediaId || legacyLink }"
      :href="legacyLink || undefined"
      :type="legacyLink ? undefined : 'button'"
      :target="legacyLink ? '_blank' : undefined"
      :rel="legacyLink ? 'noopener noreferrer' : undefined"
      :download="legacyLink ? filename : undefined"
      :disabled="legacyLink ? undefined : busy || !mediaId"
      :aria-busy="busy || undefined"
      @click="download"
    >
      <AttachmentCard
        layout="message"
        :filename="filename"
        :mime="message.body.mime"
        :bytes="bytes"
      >
        <UiIcon
          v-if="mediaId || legacyLink"
          name="download"
          class="message-file-download"
        />
      </AttachmentCard>
    </component>
    <span v-if="feedback" class="message-file-feedback" role="status">
      {{ feedback }}
    </span>
  </div>
</template>

<style scoped>
.message-file {
  display: grid;
  width: 100%;
  gap: 3px;
}
.message-file .message-file-action {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  text-decoration: none;
}
.message-file .message-file-action:disabled {
  opacity: 1;
}
.message-file .message-file-action.can-download:not(:disabled):hover {
  background: transparent;
}
.message-file-action.can-download:not(:disabled):hover > .attachment-card {
  border-color: var(--ui-selected-border);
  background: var(--ui-surface-soft);
}
.message-file-download {
  color: var(--ui-muted);
  font-size: 1rem;
}
.message-file-action:hover .message-file-download {
  color: var(--ui-primary);
}
.message-file-feedback {
  padding-inline: 2px;
  color: var(--ui-muted);
  font-size: var(--ui-font-caption);
}
</style>
