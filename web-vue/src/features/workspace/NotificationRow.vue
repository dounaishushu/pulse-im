<script setup lang="ts">
import { computed } from "vue";
import type { Notification } from "../../api/types";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";

const props = defineProps<{ row: Notification; working: boolean }>();
const emit = defineEmits<{
  read: [];
  decide: [decision: "accept" | "reject"];
  open: [id: number];
}>();
const event = computed(() => props.row.kind || props.row.type || "");
const title = computed(() => {
  switch (event.value) {
    case "group.invited":
      return "群聊邀请";
    case "group.removed":
      return "群成员变更";
    case "friend.added":
      return "新增好友";
    case "friend.accepted":
      return "好友验证已通过";
    case "friend.rejected":
      return "好友验证未通过";
    default:
      return props.row.request_id ? "好友验证" : props.row.title || "系统通知";
  }
});
const subject = computed(() => {
  const { actor_name, group_name } = props.row;
  switch (event.value) {
    case "group.invited":
      return `${actor_name || "群管理员"} 邀请你加入${group_name ? `「${group_name}」` : "群聊"}`;
    case "group.removed":
      return `你已被移出${group_name ? `「${group_name}」` : "群聊"}`;
    case "friend.added":
      return actor_name ? `你和 ${actor_name} 已成为好友` : "你有一位新好友";
    case "friend.accepted":
      return actor_name
        ? `${actor_name} 同意了你的好友请求`
        : "你的好友请求已被接受";
    case "friend.rejected":
      return actor_name
        ? `${actor_name} 拒绝了你的好友请求`
        : "你的好友请求已被拒绝";
    default:
      return actor_name && actor_name !== title.value ? actor_name : "";
  }
});
const description = computed(() => {
  const message = (props.row.message || props.row.body || "").trim();
  return message &&
    ![event.value, props.row.type, subject.value, title.value].includes(message)
    ? message
    : "";
});
const status = computed(
  () =>
    ({ accepted: "已同意", rejected: "已拒绝" })[
      props.row.request_status || ""
    ] || "",
);
const pending = computed(
  () => !!props.row.request_id && props.row.request_status === "pending",
);
const canOpen = computed(
  () =>
    !!props.row.conversation_id &&
    props.row.can_open_group !== false &&
    event.value !== "group.removed",
);
const icon = computed(() =>
  event.value.startsWith("group.")
    ? "group"
    : event.value.startsWith("friend.") || props.row.request_id
      ? "userAdd"
      : "bell",
);
</script>

<template>
  <article class="notification-row" :data-unread="row.unread">
    <div class="notification-icon">
      <AvatarImage
        v-if="row.actor_avatar_url"
        :name="row.actor_name"
        :src="row.actor_avatar_url"
      />
      <UiIcon v-else :name="icon" />
    </div>
    <div class="notification-text">
      <header class="notification-title">
        <h3>{{ title }}</h3>
        <span
          v-if="row.unread"
          class="notification-dot"
          role="img"
          aria-label="未读"
        ></span>
      </header>
      <p v-if="subject">{{ subject }}</p>
      <blockquote v-if="description">{{ description }}</blockquote>
      <div v-if="pending || canOpen || status" class="notification-actions">
        <template v-if="pending">
          <button
            type="button"
            class="notification-action secondary"
            :disabled="working"
            @click="emit('decide', 'reject')"
          >
            拒绝
          </button>
          <button
            type="button"
            class="notification-action highlight"
            :disabled="working"
            @click="emit('decide', 'accept')"
          >
            同意
          </button>
        </template>
        <span v-else-if="status" class="notification-status">{{ status }}</span>
        <button
          v-if="canOpen"
          type="button"
          class="notification-action secondary"
          :disabled="working"
          @click="emit('open', row.conversation_id!)"
        >
          查看会话 <UiIcon name="chevron" />
        </button>
      </div>
    </div>
    <div class="notification-meta">
      <slot name="time" />
      <button
        v-if="row.unread"
        class="ui-icon-button"
        type="button"
        aria-label="标为已读"
        title="标为已读"
        :disabled="working"
        @click="emit('read')"
      >
        <UiIcon name="check" />
      </button>
    </div>
  </article>
</template>

<style scoped>
.notification-row {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) auto;
  align-items: start;
  column-gap: 10px;
  padding: 12px 10px;
  border-bottom: 1px solid var(--ui-line);
}
.notification-row[data-unread="true"] {
  background: color-mix(
    in srgb,
    var(--art-active-color) 36%,
    var(--ui-surface)
  );
}
.notification-icon {
  --avatar-size: 38px;
  --avatar-radius: 8px;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 8px;
  color: var(--ui-primary);
  background: var(--art-active-color);
  font-size: 19px;
}
.notification-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.notification-row .notification-title h3 {
  margin: 0;
  color: var(--ui-text);
  font-size: var(--ui-font-control);
  font-weight: var(--ui-weight-strong);
}
.notification-dot {
  flex: 0 0 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-primary);
}
.notification-text {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.notification-text :is(p, blockquote) {
  color: var(--ui-muted);
  font-size: var(--ui-font-secondary);
  line-height: var(--ui-line-content);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.notification-text blockquote {
  padding-inline-start: 7px;
  border-inline-start: 2px solid var(--ui-line);
}
.notification-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 3px;
}
.notification-row .notification-action {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-height: 30px;
  padding: 3px 8px;
  font-size: 12px;
}
.notification-action.highlight {
  background: var(--art-active-color);
  color: var(--ui-primary);
  font-weight: 600;
}
.notification-action.secondary {
  background: transparent;
  color: var(--ui-muted);
}
.notification-action:not(:disabled):hover {
  background: var(--ui-fill);
  color: var(--ui-primary);
}
.notification-status {
  color: var(--ui-muted);
  font-size: 11px;
}
.notification-meta {
  display: grid;
  justify-items: end;
  align-content: start;
  gap: 4px;
  padding-top: 1px;
}
.notification-meta button {
  width: 28px;
  height: 28px;
  font-size: 15px;
}
@media (max-width: 620px) {
  .notification-meta button {
    width: 40px;
    height: 40px;
  }
}
</style>
