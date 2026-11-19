<script setup lang="ts">
import { shallowRef, watch } from "vue";
import UiIcon from "../../components/UiIcon.vue";

const props = defineProps<{ message: string }>();
const visible = shallowRef(false);

watch(
  () => props.message,
  (message, _previous, onCleanup) => {
    visible.value = Boolean(message);
    if (!message) return;
    const timer = window.setTimeout(() => (visible.value = false), 3000);
    onCleanup(() => window.clearTimeout(timer));
  },
  { immediate: true },
);
</script>

<template>
  <span id="composer-blocked-reason" hidden>{{ message }}</span>
  <div role="status">
    <Transition name="permission-notice" appear>
      <p v-if="visible" class="composer-permission-notice">
        <UiIcon name="alert" />
        <span>{{ message }}</span>
      </p>
    </Transition>
  </div>
</template>

<style scoped>
.composer-permission-notice {
  position: absolute;
  z-index: 5;
  inset-block-end: calc(100% + 8px);
  inset-inline-start: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  max-inline-size: 100%;
  padding: 7px 10px;
  border: 1px solid
    color-mix(in srgb, var(--ui-danger) 24%, var(--ui-danger-soft));
  border-radius: 8px;
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
  box-shadow: var(--ui-popover-shadow);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  pointer-events: none;
  transform-origin: 17px 100%;
}

.composer-permission-notice::after {
  position: absolute;
  inset-block-end: -4px;
  inset-inline-start: 14px;
  width: 7px;
  height: 7px;
  border-inline-end: inherit;
  border-block-end: inherit;
  background: inherit;
  content: "";
  transform: rotate(45deg);
}

.permission-notice-enter-active {
  animation: permission-notice-pop 390ms ease-out both;
}

.permission-notice-leave-active {
  transition: opacity 680ms ease-out;
}

.permission-notice-leave-to {
  opacity: 0;
}

@keyframes permission-notice-pop {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.97);
  }
  46% {
    opacity: 1;
    transform: translate(-2px, -2px) scale(1.02);
  }
  72% {
    transform: translate(1px, 1px) scale(0.995);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
