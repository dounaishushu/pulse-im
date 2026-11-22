<script setup lang="ts">
import { computed, shallowRef, useId, useTemplateRef } from "vue";
import ContextMenu from "../../components/ContextMenu.vue";
import UiIcon from "../../components/UiIcon.vue";
import type { Member } from "../../api/types";

import type { MemberAction } from "./memberActions";

const props = defineProps<{
  member: Member;
  owner: boolean;
  busy: boolean;
  canManage: boolean;
  canProfile: boolean;
  canAdd: boolean;
  canMention?: boolean;
  self?: boolean;
  row?: boolean;
}>();
const emit = defineEmits<{ action: [action: MemberAction] }>();
const menuId = useId();
const trigger = useTemplateRef<HTMLButtonElement>("trigger");
const expanded = shallowRef(false);
const point = shallowRef<{ x: number; y: number }>();
const revision = shallowRef(0);
const manageable = computed(() =>
  props.canManage && !props.self && props.member.role !== "owner",
);
const peerAdmin = computed(() => !props.owner && props.member.role === "admin");
const actions = computed(
  () =>
    [
      { id: "profile", icon: "profile", label: "查看资料", show: true, blocked: !props.canProfile },
      { id: "chat", icon: "chat", label: "私聊", show: !props.self, blocked: !props.canProfile },
      { id: "add", icon: "userAdd", label: "添加好友", show: !props.self && !props.member.is_contact, blocked: !props.canAdd },
      {
        id: "role",
        icon: "userSetting",
        label: props.member.role === "admin" ? "取消管理员" : "设为管理员",
        show: manageable.value && props.owner,
        blocked: false,
      },
      {
        id: "mute",
        icon: props.member.is_muted ? "volume" : "mute",
        label: props.member.is_muted ? "解除禁言" : "禁言",
        show: manageable.value,
        blocked: peerAdmin.value,
      },
      {
        id: "mention",
        icon: "group",
        label: "@ 此成员",
        show: props.row && !props.self,
        blocked: !props.canMention,
      },
      {
        id: "remove",
        icon: "delete",
        label: props.row ? "踢出群聊" : "移除成员",
        show: manageable.value,
        blocked: peerAdmin.value,
      },
      {
        id: "transfer",
        icon: "refresh",
        label: "转让群主",
        show: manageable.value && props.owner,
        blocked: false,
      },
    ] as const,
);
const menuActions = computed(() => actions.value.filter(item => props.row
  ? ["mute", "mention", "remove"].includes(item.id) : item.id !== "mention"));
function openMenu(event?: MouseEvent) {
  if (props.busy || !menuActions.value.some(item => item.show)) return;
  point.value = event && (event.clientX || event.clientY)
    ? { x: event.clientX, y: event.clientY } : undefined;
  revision.value++;
  expanded.value = true;
}
function click() {
  if (props.row) choose("profile");
  else if (expanded.value) expanded.value = false;
  else openMenu();
}
function keys(event: KeyboardEvent) {
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    event.preventDefault();
    openMenu();
  }
}
function choose(action: MemberAction) {
  const item = actions.value.find(item => item.id === action);
  if (!item?.show || item.blocked || props.busy) return;
  expanded.value = false;
  emit("action", action);
}
</script>

<template>
  <div class="member-edit" :class="{ 'member-edit-row': row }">
    <button
      ref="trigger"
      :class="row ? 'group-sidebar-member' : 'ui-icon-button member-edit-trigger'"
      type="button"
      :aria-label="(row ? '查看成员资料 ' : '编辑成员 ') + member.nickname"
      :title="row ? '查看资料（右键打开成员操作）' : '编辑成员'"
      :aria-haspopup="row ? undefined : 'menu'"
      :aria-expanded="expanded"
      :aria-controls="menuId"
      :disabled="busy"
      @click="click"
      @contextmenu.stop.prevent="openMenu($event)"
      @keydown="keys"
    >
      <slot v-if="row" />
      <UiIcon v-else name="edit" />
    </button>
    <ContextMenu
      v-if="expanded"
      :key="revision"
      :id="menuId"
      :compact="row"
      :anchor="trigger || undefined"
      :point="point"
      :label="member.nickname + ' 的成员操作'"
      @close="expanded = false"
    >
      <template v-for="item in menuActions" :key="item.id">
        <button
          v-if="item.show"
          type="button"
          class="member-menu-item"
          :class="{ 'member-menu-danger': item.id === 'remove' && !row }"
          role="menuitem"
          tabindex="-1"
          :disabled="busy || item.blocked"
          @click="choose(item.id)"
        >
          <UiIcon :name="item.icon" /> <span>{{ item.label }}</span>
        </button>
      </template>
    </ContextMenu>
  </div>
</template>

<style scoped>
.member-edit {
  margin-inline-start: auto;
  flex: none;
}
.member-edit-row {
  width: 100%;
}
.member-edit .member-edit-trigger {
  width: 34px;
  height: 34px;
  font-size: 16px;
}
.member-edit-trigger[aria-expanded="true"] {
  color: var(--ui-primary);
  background: var(--art-active-color);
}
.member-menu-item.member-menu-danger {
  color: var(--ui-danger);
}
.member-menu-item.member-menu-danger:not(:disabled):hover {
  background: var(--ui-danger-soft);
}
</style>
