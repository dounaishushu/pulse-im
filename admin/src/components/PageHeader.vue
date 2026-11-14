<script setup lang="ts">
defineProps<{ title: string }>();
</script>
<template>
  <div class="page-heading">
    <h1>{{ title }}</h1>
    <div v-if="$slots.default" class="page-heading-actions"><slot /></div>
  </div>
</template>
