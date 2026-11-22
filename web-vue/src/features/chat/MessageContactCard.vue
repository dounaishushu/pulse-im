<script setup lang="ts">
import { computed, inject } from "vue";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import { chatKey } from "../../composables/useChat";
import type { Message } from "../../api/types";

const props = defineProps<{ message: Message }>();
const chat = inject(chatKey)!;
const name = computed(() => props.message.body.nickname || props.message.body.username || "联系人");
function open() {
  if (chat.locked.value || chat.updateSuspended.value) return;
  chat.contactId.value = props.message.body.user_id;
  chat.contactContext.value = undefined;
  chat.contactCard.value = { conversation: props.message.conversation_id, message: props.message.id };
  chat.panel.value = "contacts";
}
</script>

<template>
  <button class="message-contact-card" type="button" :data-own="message.sender_id === chat.me.value?.id"
    :aria-label="'查看 ' + name + ' 的名片资料'" title="点击查看个人资料" @click="open">
    <span class="message-contact-main">
      <AvatarImage :name="name" :src="message.body.avatar_url" :media-id="message.body.avatar_id" />
      <span class="message-contact-identity">
        <strong :title="name">{{ name }}</strong>
        <span v-if="message.body.username" class="message-contact-account" :title="'@' + message.body.username">@{{ message.body.username }}</span>
        <small v-if="message.body.public_id" :title="message.body.public_id">ID：{{ message.body.public_id }}</small>
      </span>
    </span>
    <span class="message-contact-footer">个人名片 · 点击查看 <UiIcon name="chevron" /></span>
  </button>
</template>

<style scoped>
.message-contact-card { display: block; width: 100%; min-width: 0; padding: 12px 14px 9px; border: 1px solid var(--ui-line); border-radius: 8px; background: var(--ui-bubble); color: var(--ui-text); text-align: start; }
.message-contact-card[data-own="true"] { background: var(--art-active-color); }
.message-contact-card:not(:disabled):hover { box-shadow: inset 0 0 0 1px var(--ui-primary); }
.message-contact-main { display: flex; align-items: center; gap: 11px; min-width: 0; }
.message-contact-main .avatar { --avatar-size: 44px; --avatar-radius: 7px; flex: none; }
.message-contact-identity { display: grid; gap: 4px; min-width: 0; }
.message-contact-identity > * { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.message-contact-identity strong { font-size: 14px; font-weight: 600; }
.message-contact-account { font-size: 12px; color: var(--ui-muted); }
.message-contact-identity small { font-size: 10px; color: var(--ui-muted); }
.message-contact-footer { display: flex; align-items: center; gap: 3px; padding-top: 8px; margin-top: 10px; border-top: 1px solid var(--ui-line); color: var(--ui-muted); font-size: 11px; }
.message-contact-footer .ui-icon { font-size: 11px; }
</style>
