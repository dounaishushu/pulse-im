<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from "vue";
import type { ImageInstance } from "element-plus";
import { transport } from "../api/client";
import { useSession } from "../stores/session";
const props = defineProps<{ src: string; alt: string }>();
defineOptions({ inheritAttrs: false });
const picture = useTemplateRef<ImageInstance>("picture");
const session = useSession();
const url = shallowRef("");
const visible = shallowRef(false);
const mediaID = computed(() => {
  try {
    const source = new URL(props.src, location.origin);
    if (source.origin !== location.origin || source.search || source.hash) return "";
    return /^\/api\/v2\/admin\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content$/i.exec(source.pathname)?.[1] || "";
  } catch { return ""; }
});
const displayed = computed(() => mediaID.value ? url.value : props.src);
let observer: IntersectionObserver | undefined;
watch([mediaID, () => props.src, visible, session.generation, session.account], ([id, , shown], _, cleanup) => {
  url.value = "";
  if (!id || !shown || !session.account.value) return;
  const controller = new AbortController();
  let release: (() => void) | undefined;
  cleanup(() => { controller.abort(); release?.(); });
  // Image tags cannot send the entrance header retained by older logins.
  // Reuse the bounded, session-scoped authenticated media cache instead.
  void transport.acquireMedia(id, controller.signal).then(lease => {
    if (controller.signal.aborted) { lease.release(); return; }
    release = lease.release;
    url.value = lease.url;
  }).catch(() => { /* The existing error slot handles unavailable media. */ });
}, { immediate: true });
onMounted(() => {
  if (typeof IntersectionObserver === "undefined") { visible.value = true; return; }
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) {
      visible.value = true;
      observer?.disconnect();
    }
  }, { rootMargin: "100px" });
  observer.observe(picture.value!.$el);
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <el-image
    v-bind="$attrs"
    ref="picture"
    :src="displayed"
    :alt="alt"
    loading="lazy"
    :preview-src-list="displayed ? [displayed] : []"
    preview-teleported
    role="button"
    :aria-label="`查看${alt}`"
    tabindex="0"
    @keydown.enter.prevent="picture?.showPreview()"
    @keydown.space.prevent="picture?.showPreview()"
    ><template #error
      ><slot name="error"
        ><span class="muted">图片无法加载</span></slot
      ></template
    ></el-image
  >
</template>
