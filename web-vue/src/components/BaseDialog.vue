<script setup lang="ts">
import { onMounted, onScopeDispose, useTemplateRef, watch } from "vue";
const props = defineProps<{
  title: string;
  busy?: boolean;
  size?: "compact" | "wide";
}>();
const previousFocus = document.activeElement as HTMLElement | null;
onScopeDispose(() => {
  if (previousFocus?.isConnected) previousFocus.focus();
});
const emit = defineEmits<{ close: [] }>();
const panel = useTemplateRef<HTMLElement>("panel");
const body = useTemplateRef<HTMLElement>("body");
onMounted(() => panel.value?.focus());
watch(() => props.title, () => {
  if (body.value) body.value.scrollTop = 0;
  if (document.activeElement === document.body)
    panel.value?.focus({ preventScroll: true });
}, { flush: "post" });
function keys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    if (!props.busy) emit("close");
  }
  if (event.key !== "Tab") return;
  const nodes = [
    ...(panel.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]',
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
        :data-size="size"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        @keydown="keys"
      >
        <header class="vue-dialog-header">
          <h2>{{ title }}</h2>
          <button
            type="button"
            class="vue-dialog-close"
            aria-label="关闭"
            :disabled="busy"
            @click="emit('close')"
          >
            ×
          </button>
        </header>
        <div ref="body" class="vue-dialog-body"><slot /></div>
        <footer v-if="$slots.footer" class="vue-dialog-footer">
          <slot name="footer" />
        </footer>
      </section></div
  ></Teleport>
</template>
