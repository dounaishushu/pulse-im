<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, shallowRef, useTemplateRef, watch } from "vue";
import platform from "virtual:pulse-platform";
import { chatKey } from "../composables/useChat";
import { avatarLoaded, observeAvatar, requestAvatar, shareAvatar } from "./avatarRequests";
const props = defineProps<{ name?: string; src?: string; mediaId?: string }>();
const chat = inject(chatKey, undefined);
const failed = shallowRef(false);
const source = shallowRef(props.src || "");
const visible = shallowRef(false);
const element = useTemplateRef<HTMLElement>("element");
const displayed = computed(() => platform.mediaSource ? platform.mediaSource(source.value) : source.value);
const letter = computed(() => Array.from(props.name || "聊")[0]);
const tone = computed(() => (letter.value?.codePointAt(0) ?? 0) % 5);
let stopObserving: (() => void) | undefined;
let stopSharing: (() => void) | undefined;
let sourceToken = chat?.client.token;
let request: AbortController | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
let disposed = false;
function cancel() { request?.abort(); request = undefined; clearTimeout(retry); }
async function resolve(force = false) {
  if (!chat || !props.mediaId || !visible.value || request || disposed) return;
  const controller = request = new AbortController();
  const mediaId = props.mediaId, token = chat.client.token;
  try {
    const url = await requestAvatar(chat.client, mediaId, token, controller.signal, force);
    if (disposed || controller.signal.aborted || chat.client.token !== token || mediaId !== props.mediaId) return;
    source.value = url;
    sourceToken = token;
    failed.value = false;
  } catch (error) {
    if (!controller.signal.aborted && !disposed) {
      failed.value = !source.value || failed.value;
      // One bounded retry recovers an interrupted grant without holding up names
      // or starting an endless retry loop for deleted/private media.
      if (![401, 403, 404].includes((error as { status?: number }).status || 0)) scheduleRetry();
    }
  } finally { if (request === controller) request = undefined; }
}
function scheduleRetry() {
  if (retries || !props.mediaId || !chat || disposed) return;
  retries++;
  retry = setTimeout(() => { retry = undefined; void resolve(true); }, 900);
}
function imageError() {
  failed.value = true;
  if (props.src && props.src !== source.value) { source.value = props.src; failed.value = false; }
  else scheduleRetry();
}
function imageLoaded() {
  if (chat && props.mediaId && sourceToken)
    avatarLoaded(chat.client, props.mediaId, sourceToken, source.value);
}
watch(() => [props.mediaId, chat?.client.token] as const, ([id, token]) => {
  stopSharing?.();
  if (chat && id && token) stopSharing = shareAvatar(chat.client, id, token, url => {
    // A successful profile image can repair a missing copy in the member list.
    // Keep healthy images stable instead of reloading them on every token change.
    if (!source.value || failed.value) {
      cancel(); source.value = url; sourceToken = token; failed.value = false;
    }
  });
}, { immediate: true });
watch(() => [props.mediaId, props.src] as const, ([id, next], previous) => {
  const changed = id !== previous?.[0];
  if (changed) { cancel(); retries = 0; source.value = next || ""; sourceToken = chat?.client.token; failed.value = false; }
  else if (!next || failed.value || !source.value ||
    window.PulseMediaIdentity?.identity(next) !== window.PulseMediaIdentity?.identity(source.value)) {
    source.value = next || ""; sourceToken = chat?.client.token; failed.value = false;
  }
  if (!source.value) void resolve();
});
watch(visible, value => {
  if (value && !source.value) void resolve();
  else if (!value) cancel();
});
onMounted(() => {
  if (element.value) stopObserving = observeAvatar(element.value, value => { visible.value = value; });
});
onScopeDispose(() => { disposed = true; stopObserving?.(); stopSharing?.(); cancel(); });
</script>
<template>
  <span ref="element" class="avatar" :data-tone="tone" aria-hidden="true">
    <img v-if="displayed && !failed" :src="displayed" alt="" loading="lazy" decoding="async" @error="imageError" @load="imageLoaded" />
    <span v-else>{{ letter }}</span>
  </span>
</template>

<style scoped>
.avatar {
  width: var(--avatar-size, 36px);
  height: var(--avatar-size, 36px);
  flex: 0 0 var(--avatar-size, 36px);
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: var(--avatar-radius, 7px);
  background: color-mix(
    in srgb,
    var(--avatar-bg, #e3edf9) var(--avatar-surface-mix),
    var(--ui-surface)
  );
  color: color-mix(
    in srgb,
    var(--avatar-ink, #325986) var(--avatar-ink-mix),
    var(--avatar-bg, #e3edf9)
  );
  font-size: calc(var(--avatar-size, 36px) * 0.4);
  font-weight: 650;
  line-height: 1;
  user-select: none;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}
.avatar[data-tone="1"] {
  --avatar-bg: #e3f1ed;
  --avatar-ink: #28715e;
}
.avatar[data-tone="2"] {
  --avatar-bg: #f4e9d7;
  --avatar-ink: #865f27;
}
.avatar[data-tone="3"] {
  --avatar-bg: #ece8f6;
  --avatar-ink: #664a91;
}
.avatar[data-tone="4"] {
  --avatar-bg: #f6e7e8;
  --avatar-ink: #914958;
}
</style>
