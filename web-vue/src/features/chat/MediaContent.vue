<script setup lang="ts">
import {
  computed,
  inject,
  onScopeDispose,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import { chatKey } from "../../composables/useChat";
import { usePreferences } from "../../composables/usePreferences";
import { client } from "../../api/client";
import type { Message } from "../../api/types";
const props = defineProps<{ message: Message }>(),
  emit = defineEmits<{ open: [source: string] }>();
const chat = inject(chatKey)!,
  preferences = usePreferences();
const failed = shallowRef(false),
  source = shallowRef(""),
  manual = shallowRef(false),
  gifPlaying = shallowRef(false),
  loadKey = shallowRef(0);
const media = useTemplateRef<HTMLMediaElement>("media");
const id = computed(() => props.message.body._go_media_id);
const kind = computed(() =>
  props.message.type === "file" &&
  /^video\//i.test(props.message.body.mime || "")
    ? "video"
    : props.message.type,
);
const gif = computed(
  () =>
    kind.value === "image" &&
    (props.message.body.mime === "image/gif" ||
      /\.gif(?:$|[?#])/i.test(props.message.body.name || "")),
);
const category = computed(() =>
  kind.value === "image"
    ? "photos"
    : kind.value === "video"
      ? "videos"
      : "files",
);
const enabled = computed(() => {
  void preferences.revision.value;
  const scope =
    chat.active.value?.type === "channel"
      ? "channel"
      : chat.active.value?.type === "group"
        ? "group"
        : "private";
  const value =
    localStorage.getItem(
      `pulse_setting_media_download_${scope}_${category.value}`,
    ) ?? localStorage.getItem("pulse_setting_auto_download_" + scope);
  const max =
    Number(
      localStorage.getItem("pulse_media_download_" + scope + "_max_mb") || 50,
    ) *
    1024 *
    1024;
  return (
    manual.value ||
    (value !== "0" &&
      (!props.message.body.size || props.message.body.size <= max))
  );
});
const showGif = computed(
  () => !gif.value || preferences.setting("animated_gif") || gifPlaying.value,
);
let revision = 0,
  attempts = 0,
  retrying = false,
  timer: ReturnType<typeof setTimeout> | undefined;
const controller = new AbortController(),
  token = client.token,
  conversation = props.message.conversation_id;
const current = () =>
  !controller.signal.aborted &&
  client.token === token &&
  props.message.conversation_id === conversation;
async function load(force = false) {
  const mine = ++revision;
  try {
    let url =
      force && id.value
        ? await client.mediaGrant(id.value, undefined, controller.signal, true)
        : props.message.body.thumbnail_url || props.message.body.url || "";
    if (!url && id.value)
      url = await client.mediaGrant(id.value, undefined, controller.signal);
    if (kind.value === "image" && !gif.value) {
      const parsed = new URL(url, location.href);
      parsed.pathname = parsed.pathname.replace(/\/content$/, "/preview");
      url = parsed.href;
    }
    if (current() && mine === revision) {
      source.value = url;
      if (force) loadKey.value++;
      failed.value = false;
    }
  } catch (cause) {
    if (current() && mine === revision) {
      if (
        [401, 403, 404, 409].includes(
          (cause as { status?: number }).status || 0,
        )
      )
        failed.value = true;
      else {
        retrying = false;
        retry();
      }
    }
  } finally {
    if (mine === revision) retrying = false;
  }
}
function retry() {
  if (retrying || timer || !current()) return;
  if (attempts >= 2) {
    failed.value = true;
    return;
  }
  const delay = [300, 900][attempts++]!;
  timer = setTimeout(() => {
    timer = undefined;
    if (!current()) return;
    retrying = true;
    void load(true);
  }, delay);
}
function manualRetry() {
  clearTimeout(timer);
  timer = undefined;
  attempts = 0;
  failed.value = false;
  retrying = false;
  void load(true);
}
function loaded() {
  clearTimeout(timer);
  timer = undefined;
  attempts = 0;
  retrying = false;
  failed.value = false;
}
async function audioSettings() {
  void preferences.revision.value;
  const element = media.value;
  if (!element) return;
  element.volume =
    Math.max(
      0,
      Math.min(100, Number(localStorage.getItem("pulse_output_volume") ?? 100)),
    ) / 100;
  const sink = localStorage.getItem("pulse_audio_output") || "default";
  if ("setSinkId" in element && typeof element.setSinkId === "function")
    try {
      await element.setSinkId(sink);
    } catch {
      /* Fall back to the browser output device. */
    }
}
watch([media, preferences.revision], audioSettings);
watch(
  () =>
    id.value ||
    window.PulseMediaIdentity.identity(props.message.body.url || ""),
  () => {
    clearTimeout(timer);
    timer = undefined;
    attempts = 0;
    failed.value = false;
    manual.value = false;
    gifPlaying.value = false;
    void load();
  },
  { immediate: true },
);
onScopeDispose(() => {
  revision++;
  controller.abort();
  clearTimeout(timer);
  media.value?.pause();
});
</script>
<template>
  <button v-if="!enabled" class="secondary-button" @click="manual = true">
    点击加载{{ kind === "image" ? "图片" : "附件" }}
  </button>
  <button v-else-if="!showGif" @click="gifPlaying = true">播放 GIF 图片</button>
  <div v-else-if="failed" class="vue-media-error" role="status">
    附件加载失败<button @click="manualRetry">重试</button>
  </div>
  <span v-else-if="!source" role="status">附件加载中…</span>
  <button
    v-else-if="kind === 'image'"
    class="vue-image-button"
    @click="emit('open', message.body.url || source)"
  >
    <img
      :key="loadKey"
      :src="source"
      :alt="message.body.name || '图片消息'"
      :width="message.body.width"
      :height="message.body.height"
      :style="
        message.body.width && message.body.height
          ? {
              aspectRatio: message.body.width + '/' + message.body.height,
              height: 'auto',
            }
          : {}
      "
      loading="lazy"
      @load="loaded"
      @error="retry"
    />
  </button>
  <video
    v-else-if="kind === 'video'"
    ref="media"
    :key="loadKey"
    :src="source"
    controls
    preload="metadata"
    @loadedmetadata="loaded"
    @error="retry"
  ></video>
  <audio
    v-else-if="kind === 'voice' || kind === 'audio'"
    ref="media"
    :key="loadKey"
    :src="source"
    controls
    preload="metadata"
    @loadedmetadata="loaded"
    @error="retry"
  ></audio>
  <a
    v-else
    :href="source"
    target="_blank"
    rel="noreferrer"
    :download="message.body.name"
    >{{ message.body.name || "下载文件" }}</a
  >
</template>
