<script setup lang="ts">
// Retain the product glyphs from legacy Web's navIcon().
defineProps<{
  name: "profile" | "notifications" | "privacy" | "chat" | "media" | "advanced" |
    "language" | "password" | "security" | "help";
}>();
</script>

<template>
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path v-if="name === 'profile'" d="m4 16-1 5 5-1L19 9l-4-4Zm9-10 4 4" />
    <path v-else-if="name === 'notifications'" d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    <path v-else-if="name === 'chat'" d="M20 11a7 7 0 0 1-7 7H9l-5 3v-6a7 7 0 0 1 0-10 7 7 0 0 1 10 0M14 7a5 5 0 0 1 7 7v4l-3-2" />
    <path v-else-if="name === 'media'" d="M6 3h3l2 5-2 2a14 14 0 0 0 5 5l2-2 5 2v3c0 1-1 2-2 2C11 19 5 13 4 5c0-1 1-2 2-2Z" />
    <template v-else-if="name === 'advanced'">
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" fill="currentColor" />
      <circle cx="15" cy="12" r="2" fill="currentColor" />
      <circle cx="11" cy="18" r="2" fill="currentColor" />
    </template>
    <template v-else-if="name === 'language'">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </template>
    <template v-else-if="name === 'help'">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.7 9a2.4 2.4 0 1 1 4.3 1.5c-.7.8-2 1.1-2 2.5M12 16.5v.1" />
    </template>
    <template v-else>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </template>
  </svg>
</template>
