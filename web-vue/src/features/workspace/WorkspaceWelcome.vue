<script setup lang="ts">
import brand from "../../assets/pulse-mark.webp";
import UiIcon from "../../components/UiIcon.vue";

const emit = defineEmits<{ contacts: [] }>();
</script>

<template>
  <section class="workspace-welcome" aria-labelledby="workspace-welcome-title">
    <div class="welcome-mark" aria-hidden="true">
      <img :src="brand" alt="" width="58" height="58" />
    </div>
    <h2 id="workspace-welcome-title">选择一个会话</h2>
    <button class="welcome-contacts" type="button" @click="emit('contacts')">
      <UiIcon name="profile" /> 查看联系人
    </button>
  </section>
</template>

<style scoped>
.workspace-welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  padding: 24px 24px clamp(24px, 10vh, 88px);
  background: radial-gradient(
    ellipse at 50% 44%,
    color-mix(in srgb, var(--art-active-color) 52%, var(--ui-surface)),
    var(--ui-surface) 66%
  );
  text-align: center;
}
.welcome-mark {
  display: grid;
  place-items: center;
  width: 96px;
  height: 96px;
  margin-block-end: 22px;
  border: 1px solid color-mix(in srgb, var(--ui-line), var(--art-active-color));
  border-radius: 28px;
  background: color-mix(in srgb, var(--ui-surface) 88%, var(--art-active-color));
  box-shadow: 0 8px 22px color-mix(in srgb, var(--ui-primary) 8%, transparent);
}
.welcome-mark img {
  border-radius: 16px;
}
#workspace-welcome-title {
  font-size: var(--ui-font-heading);
  line-height: var(--ui-line-heading);
  font-weight: var(--ui-weight-strong);
}
.workspace-welcome .welcome-contacts {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  margin-block-start: 19px;
  padding: 6px 14px;
  border: 1px solid var(--ui-line);
  border-radius: 9px;
  background: var(--ui-surface);
  color: var(--ui-primary);
  font-size: var(--ui-font-control);
  font-weight: var(--ui-weight-strong);
}
.workspace-welcome .welcome-contacts:hover {
  background: var(--art-active-color);
  border-color: var(--ui-selected-border);
}
.welcome-contacts .ui-icon {
  font-size: 17px;
}
</style>
