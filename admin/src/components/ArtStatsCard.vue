<script setup lang="ts">
// Adapted from Art Design Pro's ArtStatsCard. See THIRD_PARTY_NOTICES.md.
import ArtIcon from "./ArtIcon.vue";
withDefaults(
  defineProps<{
    title: string;
    count?: number;
    description?: string;
    icon: string;
    color?: string;
  }>(),
  { color: "blue", count: 0 },
);
</script>
<template>
  <article class="art-card stat-card" :class="`stat-${color}`">
    <div class="stat-top">
      <span>{{ title }}</span><span class="stat-icon"
        ><ArtIcon :name="icon" :size="21"
      /></span>
    </div>
    <strong class="stat-number">{{
      Number(count || 0).toLocaleString("zh-CN")
    }}</strong>
    <p v-if="description" class="stat-description">{{ description }}</p>
  </article>
</template>
