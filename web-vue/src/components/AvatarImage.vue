<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
const props = defineProps<{ name?: string; src?: string }>();
const failed = shallowRef(false);
const source = shallowRef(props.src || "");
const letter = computed(() => Array.from(props.name || "聊")[0]);
watch(
  () => props.src,
  (next) => {
    failed.value = false;
    if (
      !next ||
      !source.value ||
      window.PulseMediaIdentity?.identity(next) !==
        window.PulseMediaIdentity?.identity(source.value)
    )
      source.value = next || "";
  },
);
</script>
<template>
  <span class="avatar"
    ><img
      v-if="source && !failed"
      :src="source"
      alt=""
      loading="lazy"
      @error="
        props.src && props.src !== source
          ? (source = props.src)
          : (failed = true)
      "
    /><span v-else>{{ letter }}</span></span
  >
</template>
