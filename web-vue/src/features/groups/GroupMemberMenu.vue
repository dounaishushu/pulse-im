<script setup lang="ts">
import {
  computed,
  nextTick,
  onScopeDispose,
  shallowRef,
  useId,
  useTemplateRef,
} from "vue";
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
  self?: boolean;
  row?: boolean;
}>();
const emit = defineEmits<{ action: [action: MemberAction] }>();
const menuId = useId();
const trigger = useTemplateRef<HTMLButtonElement>("trigger");
const menu = useTemplateRef<HTMLElement>("menu");
const expanded = shallowRef(false);
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
        id: "remove",
        icon: "delete",
        label: "移除成员",
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
let lifetime: AbortController | undefined;
let fallbackObserver: ResizeObserver | undefined;
const nativeAnchor =
  CSS.supports("position-area", "block-end span-inline-start") &&
  CSS.supports("position-try-fallbacks", "flip-block");

function stopTracking() {
  lifetime?.abort();
  fallbackObserver?.disconnect();
}
onScopeDispose(stopTracking);

function entries() {
  return Array.from(
    menu.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ||
      [],
  );
}
function close(restoreFocus = false) {
  menu.value?.hidePopover();
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function positionMenu(popup: HTMLElement, button: HTMLButtonElement) {
  const bounds = button.getBoundingClientRect();
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const viewport = window.visualViewport;
  const leftEdge = (viewport?.offsetLeft || 0) / zoom;
  const topEdge = (viewport?.offsetTop || 0) / zoom;
  const rightEdge = leftEdge + (viewport?.width || window.innerWidth) / zoom;
  const bottomEdge = topEdge + (viewport?.height || window.innerHeight) / zoom;
  const height = popup.offsetHeight;
  const gap = 6;
  const below = bounds.bottom / zoom + gap;
  const above = bounds.top / zoom - height - gap;
  const y = below + height <= bottomEdge - gap ? below : above;
  popup.style.insetInlineStart = `${Math.max(leftEdge + gap, Math.min(bounds.right / zoom, rightEdge - gap) - popup.offsetWidth)}px`;
  popup.style.insetBlockStart = `${Math.max(topEdge + gap, y)}px`;
}

async function toggled(event: ToggleEvent) {
  stopTracking();
  expanded.value = event.newState === "open";
  const popup = menu.value;
  const button = trigger.value;
  if (!expanded.value || !popup || !button) return;
  await nextTick();
  if (!popup.matches(":popover-open")) return;
  if (!nativeAnchor) {
    const reposition = () => positionMenu(popup, button);
    reposition();
    const list = button.closest(".group-members-section");
    if (list) {
      fallbackObserver = new ResizeObserver(reposition);
      fallbackObserver.observe(list);
    }
  }
  (entries()[0] || popup).focus({ preventScroll: true });

  lifetime = new AbortController();
  const { signal } = lifetime;
  window.addEventListener("resize", () => close(), { signal });
  window.addEventListener(
    "scroll",
    (scroll) => {
      if (!(scroll.target instanceof Node) || !popup.contains(scroll.target))
        close();
    },
    { capture: true, passive: true, signal },
  );
}
function keys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
    return;
  }
  if (event.key === "Tab") {
    close(true);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = entries();
  if (!buttons.length) return;
  const here = buttons.findIndex((button) => button === document.activeElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (here + step + buttons.length) % buttons.length;
  buttons[index]?.focus();
}
function choose(action: MemberAction) {
  close(true);
  emit("action", action);
}
</script>

<template>
  <div class="member-edit" :class="{ 'member-edit-row': row }">
    <button
      ref="trigger"
      :class="row ? 'group-sidebar-member' : 'ui-icon-button member-edit-trigger'"
      type="button"
      :aria-label="(row ? '成员操作 ' : '编辑成员 ') + member.nickname"
      :title="row ? '成员操作' : '编辑成员'"
      aria-haspopup="menu"
      :aria-expanded="expanded"
      :aria-controls="menuId"
      :popovertarget="menuId"
      :disabled="busy"
      @contextmenu.prevent="menu?.showPopover()"
    >
      <slot v-if="row" />
      <UiIcon v-else name="edit" />
    </button>
    <div
      :id="menuId"
      ref="menu"
      class="member-menu"
      popover="auto"
      role="menu"
      :aria-label="member.nickname + ' 的成员操作'"
      tabindex="-1"
      @toggle="toggled"
      @keydown="keys"
    >
      <template v-if="expanded">
        <template v-for="item in actions" :key="item.id">
          <button
            v-if="item.show"
            type="button"
            class="member-menu-item"
            :class="{ 'member-menu-danger': item.id === 'remove' }"
            role="menuitem"
            tabindex="-1"
            :disabled="busy || item.blocked"
            @click="choose(item.id)"
          >
            <UiIcon :name="item.icon" /> <span>{{ item.label }}</span>
          </button>
        </template>
      </template>
    </div>
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
.member-menu {
  position: fixed;
  inset: auto;
  margin: 0;
  padding: 4px;
  width: min(160px, calc(100vw - 12px));
  max-height: calc(100dvh - 12px);
  overflow: auto;
  color: var(--ui-text);
  background: var(--ui-surface);
  border: 1px solid var(--ui-line);
  border-radius: 8px;
  box-shadow: var(--ui-popover-shadow);
}
@supports (position-area: block-end span-inline-start) and
  (position-try-fallbacks: flip-block) {
  .member-menu {
    position-area: block-end span-inline-start;
    position-try-fallbacks:
      flip-block,
      flip-inline,
      flip-block flip-inline;
    justify-self: end;
    align-self: start;
    margin-block-start: 6px;
  }
}
.member-menu .member-menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  background: transparent;
  text-align: start;
  font-size: 13px;
}
.member-menu-item .ui-icon {
  font-size: 15px;
}
.member-menu-item:focus-visible {
  outline-offset: -2px;
}
.member-menu .member-menu-danger {
  color: var(--ui-danger);
}
.member-menu .member-menu-danger:not(:disabled):hover {
  background: var(--ui-danger-soft);
}
</style>
