<script setup lang="ts">
import { onMounted, onScopeDispose, useTemplateRef } from "vue";
const props = defineProps<{ title: string; busy?: boolean }>();
const previousFocus = document.activeElement as HTMLElement | null;
onScopeDispose(() => {
  if (previousFocus?.isConnected) previousFocus.focus();
});
const emit = defineEmits<{ close: [] }>();
const panel = useTemplateRef<HTMLElement>("panel");
onMounted(() => panel.value?.focus());
function keys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    if (!props.busy) emit("close");
  }
  if (event.key !== "Tab") return;
  const nodes = [
    ...(panel.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
    ) || []),
  ].filter((node) => node.getClientRects().length);
  if (!nodes.length) {
    event.preventDefault();
    return;
  }
  if (
    event.shiftKey &&
    (document.activeElement === nodes[0] ||
      document.activeElement === panel.value)
  ) {
    event.preventDefault();
    nodes.at(-1)?.focus();
  } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
    event.preventDefault();
    nodes[0]?.focus();
  }
}
</script>
<template>
  <Teleport to="body"
    ><div class="vue-modal-backdrop" @click.self="!busy && emit('close')">
      <section
        ref="panel"
        class="vue-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        @keydown="keys"
      >
        <header>
          <h2>{{ title }}</h2>
          <button
            type="button"
            aria-label="关闭"
            :disabled="busy"
            @click="emit('close')"
          >
            ×
          </button>
        </header>
        <slot />
      </section></div
  ></Teleport>
</template>
