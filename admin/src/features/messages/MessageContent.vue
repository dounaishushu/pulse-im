<script setup lang="ts">
import { shallowRef, onBeforeUnmount, watch } from "vue";
import { mediaURL, transport, saveBlob } from "../../api/client";
import { ElMessage } from "element-plus";
import type { RecordData } from "../../domain/types";
const props = defineProps<{ message: RecordData; detail?: boolean }>();
const url = shallowRef(""),
  busy = shallowRef(false),
  error = shallowRef("");
let controller: AbortController | undefined;
watch(
  () => props.message,
  () => {
    controller?.abort();
    url.value = "";
    error.value = "";
    busy.value = false;
  },
);
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  controller = new AbortController();
  try {
    url.value = await transport.mediaBlob(
      props.message.body._go_media_id,
      controller.signal,
    );
    if (props.message.type === "file") {
      const response = await fetch(url.value);
      saveBlob(await response.blob(), props.message.body.name || "附件");
    }
  } catch (e: any) {
    if (e.name !== "AbortError") {
      error.value = e.message;
      ElMessage.error(e.message);
    }
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <div class="message-content">
    <span v-if="message.recalled_at" class="muted">{{
      message.type === "text" ? message.body?.text : "附件（已撤回）"
    }}</span>
    <template v-else-if="message.type === 'image'"
      ><el-image
        v-if="mediaURL(message.body?.url || message.body?.image_url)"
        :src="mediaURL(message.body.url || message.body.image_url)"
        loading="lazy"
        :preview-src-list="[
          mediaURL(message.body.url || message.body.image_url),
        ]"
        preview-teleported
        fit="contain"
        :class="detail ? 'full-image' : 'message-thumb'"
        ><template #error
          ><span class="muted">图片加载失败</span></template
        ></el-image
      ><span v-else class="muted">图片暂不可用</span>
      <p v-if="message.body?.text" class="message-text">
        {{ message.body.text }}
      </p></template
    >
    <template
      v-else-if="
        ['video', 'voice', 'file'].includes(message.type) &&
        message.body?._go_media_id
      "
      ><span>{{
        message.body.name ||
        { video: "视频", voice: "语音", file: "文件" }[message.type as "video"]
      }}</span>
      <div v-if="detail" class="mt-3">
        <video
          v-if="url && message.type === 'video'"
          :src="url"
          controls
          preload="metadata"
          class="private-video"
        /><audio
          v-else-if="url && message.type === 'voice'"
          :src="url"
          controls
          preload="metadata"
        /><el-button
          :loading="busy"
          :disabled="!!url && message.type !== 'file'"
          @click="load"
          >{{ message.type === "file" ? "下载附件" : "加载播放" }}</el-button
        >
        <p v-if="error" class="field-help">{{ error }}</p>
      </div></template
    >
    <p v-else class="message-text">
      {{
        message.body?.text ||
        (message.type === "contact_card"
          ? `个人名片：${message.body?.nickname || message.body?.username || message.body?.user_id || ""}`
          : message.body?.file_name ||
            message.body?.name ||
            JSON.stringify(message.body, null, detail ? 2 : 0))
      }}
    </p>
  </div>
</template>
<style scoped>
.message-text {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 80px;
  overflow: hidden;
}
.message-thumb {
  width: 80px;
  height: 55px;
  border-radius: 6px;
}
.full-image {
  max-width: 100%;
  height: auto;
  max-height: 60vh;
}
.private-video {
  max-width: 100%;
  max-height: 60vh;
}
.message-content audio {
  width: 100%;
}
.message-content:has(.full-image) .message-text {
  max-height: none;
}
.message-content {
  min-width: 0;
}
</style>
