<script setup lang="ts">
import { useTemplateRef } from "vue";
import type { ImageInstance } from "element-plus";
defineProps<{ src: string; alt: string }>();
const picture = useTemplateRef<ImageInstance>("picture");
</script>
<template>
  <el-image
    ref="picture"
    :src="src"
    :alt="alt"
    loading="lazy"
    :preview-src-list="src ? [src] : []"
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
