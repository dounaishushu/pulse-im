<script setup lang="ts">
import { computed } from "vue";
import platform from "virtual:pulse-platform";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import { textOf, type Conversation } from "../../api/types";
import { sessionListDate } from "./sessionListDate";

const props = defineProps<{
  row: Conversation;
  selected: boolean;
  draft?: string;
}>();
const emit = defineEmits<{ open: []; menu: [event: MouseEvent] }>();
const timestamp = computed(
  () => props.row.last_message?.created_at || props.row.updated_at,
);
const time = computed(() => sessionListDate(timestamp.value));
const preview = computed(() => props.draft || textOf(props.row.last_message));
const presence = computed(() => {
  const row = props.row;
  if (platform.name === "pc" && row.type === "direct" && row.peer_last_seen_hidden !== true && typeof row.peer_online === "boolean") {
    return row.peer_online ? "在线" : "离线";
  }
  return undefined;
});
</script>

<template>
  <button
    type="button"
    class="conversation conversation-row"
    :class="{ active: selected }"
    :data-conversation-id="row.id"
    :aria-current="selected ? 'true' : undefined"
    @click="emit('open')"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <span class="conversation-avatar">
      <AvatarImage :name="row.name" :src="row.avatar_url" />
      <span v-if="presence" class="conversation-presence" :class="{ online: row.peer_online }"
        role="img" :aria-label="presence" :title="presence" />
    </span>
    <span class="vue-conversation-copy">
      <span class="conversation-row-title">
        <strong :title="row.name">{{ row.name }}</strong>
        <time v-if="time" :datetime="timestamp">{{ time }}</time>
      </span>
      <span class="conversation-row-detail">
        <small class="conversation-preview">
          <span v-if="draft" class="conversation-draft">[草稿] </span>
          <span v-else-if="row.unread_mention_count" class="conversation-draft"
            >[有人@我] </span
          >{{ preview }}
        </small>
        <span class="conversation-indicators">
          <span
            v-if="row.is_pinned"
            class="conversation-marker"
            aria-label="已置顶"
            title="已置顶"
            ><UiIcon name="bookmark"
          /></span>
          <span
            v-if="row.notifications_muted"
            class="conversation-marker"
            aria-label="已静音"
            title="已静音"
            ><UiIcon name="bell"
          /></span>
          <span
            v-if="row.unread_count"
            class="unread"
            :class="{ 'is-muted': row.notifications_muted }"
          >
            {{ row.unread_count > 99 ? "99+" : row.unread_count }}
          </span>
        </span>
      </span>
    </span>
  </button>
</template>

<style scoped>
.conversation-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 63px;
  padding: 8px 10px 8px 12px;
  text-align: start;
  min-width: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
}
.conversation-row.active,
.conversation-row.active:hover {
  background: var(--art-active-color);
}
.conversation-row.active::before {
  position: absolute;
  inset-block: 16px;
  inset-inline-start: 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--ui-primary);
  content: "";
}
.conversation-row:focus-visible {
  outline-offset: -2px;
}
.conversation-avatar {
  display: inline-flex;
  position: relative;
  flex: none;
}
.conversation-presence {
  position: absolute;
  inset: auto -1px -1px auto;
  width: 12px;
  height: 12px;
  border: 2px solid var(--ui-surface);
  border-radius: 50%;
  background: var(--ui-muted);
}
.conversation-presence.online { background: var(--ui-success); }
.conversation-row .avatar {
  --avatar-size: 40px;
  --avatar-radius: 10px;
}
.vue-conversation-copy {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 5px;
}
.conversation-row-title,
.conversation-row-detail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}
.conversation-row-title strong {
  font-size: var(--ui-font-control);
  font-weight: var(--ui-weight-strong);
}
.conversation-row-title :is(strong, time),
.conversation-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conversation-row-title time {
  color: var(--ui-muted);
  font-size: var(--ui-font-caption);
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.conversation-preview {
  color: var(--ui-muted);
  font-size: var(--ui-font-secondary);
}
.conversation-draft {
  color: var(--ui-danger);
}
.conversation-indicators {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.conversation-marker {
  display: inline-flex;
  font-size: 12px;
  color: var(--ui-muted);
}

@media (max-width: 760px) {
  .conversation-row {
    min-height: 60px;
  }
}
</style>
