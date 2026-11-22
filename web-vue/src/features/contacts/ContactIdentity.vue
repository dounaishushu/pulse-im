<script setup lang="ts">
import AvatarImage from "../../components/AvatarImage.vue";

defineProps<{
  name: string;
  avatar?: string;
  avatarId?: string;
  subtitle?: string;
  wrapSubtitle?: boolean;
}>();
</script>

<template>
  <span class="contact-identity">
    <AvatarImage :name="name" :src="avatar" :media-id="avatarId" />
    <span class="contact-identity-text">
      <strong :title="name">{{ name }}</strong>
      <small
        v-if="subtitle"
        :class="{ 'wrap-subtitle': wrapSubtitle }"
        :title="subtitle"
        >{{ subtitle }}</small
      >
    </span>
  </span>
</template>

<style scoped>
.contact-identity {
  --avatar-size: 40px;
  --avatar-radius: 8px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  text-align: start;
}
.contact-identity-text {
  display: grid;
  gap: 3px;
  min-width: 0;
  color: var(--ui-text);
  line-height: 1.35;
}
.contact-identity-text > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.contact-identity-text strong {
  font-size: var(--ui-font-control);
  font-weight: var(--ui-weight-strong);
}
.contact-identity-text small {
  color: var(--ui-muted);
  font-size: var(--ui-font-secondary);
}
.contact-identity-text .wrap-subtitle {
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
