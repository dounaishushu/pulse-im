<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
const props = defineProps<{ name?: string; src?: string }>();
const failed = shallowRef(false);
const source = shallowRef(props.src || "");
const letter = computed(() => Array.from(props.name || "聊")[0]);
const tone = computed(() => (letter.value?.codePointAt(0) ?? 0) % 5);
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
  <span class="avatar" :data-tone="tone" aria-hidden="true"
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
