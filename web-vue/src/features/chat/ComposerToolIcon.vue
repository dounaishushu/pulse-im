<script setup lang="ts">
defineProps<{
  name:
    | "emoji"
    | "screenshot"
    | "paperclip"
    | "camera"
    | "microphone"
    | "at"
    | "contactCard"
    | "shake";
}>();
</script>

<template>
  <svg
    class="composer-tool-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="name === 'emoji'">
      <circle cx="12" cy="12" r="8.8" />
      <path d="M8.6 13.7a4 4 0 0 0 6.8 0M9 9.7h.2m5.6 0h.2" />
    </template>
    <template v-else-if="name === 'screenshot'">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M7.8 7.8 20 20M7.8 16.2l5.5-5.5m2.8-2.8L20 4" />
    </template>
    <path
      v-else-if="name === 'paperclip'"
      d="m8.8 14.2 6.5-6.5a1.9 1.9 0 0 1 2.7 2.7l-8.1 8.1a3.7 3.7 0 0 1-5.2-5.2l8.8-8.8"
    />
    <template v-else-if="name === 'camera'">
      <path
        d="M5 7h3.2l1.4-2h4.8l1.4 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"
      />
      <circle cx="12" cy="12.8" r="3.1" />
    </template>
    <template v-else-if="name === 'microphone'">
      <rect x="8.8" y="3.3" width="6.4" height="11.8" rx="3.2" />
      <path d="M5.8 11.7v.4a6.2 6.2 0 0 0 12.4 0v-.4M12 18.3V21m-3 0h6" />
    </template>
    <template v-else-if="name === 'at'">
      <circle cx="11.6" cy="11.8" r="3.1" />
      <path d="M14.7 8.7v4.9a2.2 2.2 0 0 0 4.4 0v-1.8a7.5 7.5 0 1 0-3.3 6.2" />
    </template>
    <template v-else-if="name === 'contactCard'">
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <circle cx="8.6" cy="10.4" r="1.6" />
      <path d="M6.1 15.5a2.6 2.6 0 0 1 5 0m2.9-5h3.9M14 14h3.9" />
    </template>
    <path
      v-else-if="name === 'shake'"
      d="M13.8 3.6 5.7 13.5h5.2l-.7 6.9 8.1-9.9h-5.2l.7-6.9Z"
    />
  </svg>
</template>

<style scoped>
.composer-tool-icon {
  display: block;
  flex: none;
  inline-size: 1em;
  block-size: 1em;
}
</style>
