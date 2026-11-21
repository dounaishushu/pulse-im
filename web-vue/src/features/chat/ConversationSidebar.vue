<script setup lang="ts">
import UiIcon from "../../components/UiIcon.vue";
import platform from "virtual:pulse-platform";
import ConversationRow from "./ConversationRow.vue";
import {
  computed,
  inject,
  nextTick,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import { chatKey } from "../../composables/useChat";
import BaseDialog from "../../components/BaseDialog.vue";
import { usePreferences } from "../../composables/usePreferences";
import type { Conversation } from "../../api/types";
const emit = defineEmits<{ open: []; addContact: [] }>();
const chat = inject(chatKey)!;
async function openConversation(id: number) {
  const focus = document.activeElement;
  emit("open");
  await chat.choose(id);
  if (
    chat.active.value?.id === id &&
    !chat.interactionBusy.value &&
    document.activeElement === focus
  )
    document.getElementById("message-input")?.focus({ preventScroll: true });
}
const { active, folders, visible, tab, archived, search } = chat;
const preferences = usePreferences();
const ungrouped = computed(() => {
  void preferences.revision.value;
  return (
    localStorage.getItem(
      "pulse_ungrouped_collapsed_" +
        (tab.value === "friends" ? "direct" : "groups"),
    ) === "1"
  );
});
watch(tab, () => {
  archived.value = false;
});
const folderTarget = shallowRef<Conversation | null>(null),
  newFolderOpen = shallowRef(false),
  folderName = shallowRef(""),
  folderId = shallowRef(0),
  folderBusy = shallowRef(false);
const shareUser = shallowRef<number | null>(null),
  shareQuery = shallowRef("");
const shareTargets = computed(() =>
  chat.conversations.value.filter(
    (row) =>
      row.can_send !== false &&
      !row.is_hidden &&
      row.name.toLowerCase().includes(shareQuery.value.toLowerCase()),
  ),
);
const shareIds = new Map<number, string>();
async function share(target: number) {
  if (!shareUser.value || folderBusy.value) return;
  folderBusy.value = true;
  try {
    if (!shareIds.has(target))
      shareIds.set(target, "card-" + crypto.randomUUID());
    await chat.post("/messages", {
      conversation_id: target,
      type: "contact_card",
      body: { user_id: shareUser.value },
      request_id: shareIds.get(target),
    });
    shareUser.value = null;
    void chat.summary([target]);
  } catch (cause) {
    chat.error(cause);
  } finally {
    folderBusy.value = false;
  }
}
async function assignFolder() {
  if (!folderTarget.value || folderBusy.value) return;
  folderBusy.value = true;
  try {
    await chat.mutate("/conversation-folders/assign", {
      conversation_id: folderTarget.value.id,
      folder_id: folderId.value,
    });
    folderTarget.value = null;
  } catch (cause) {
    chat.error(cause);
  } finally {
    folderBusy.value = false;
  }
}

const context = shallowRef<Conversation | null>(null);
const contextEl = useTemplateRef<HTMLElement>("contextEl");
const contextPosition = shallowRef({ left: "12px", top: "90px" });
let contextTrigger: HTMLElement | null = null;
async function openContext(row: Conversation, event: MouseEvent) {
  context.value = row;
  contextTrigger =
    event.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : (document.activeElement as HTMLElement);
  const target = contextTrigger?.getBoundingClientRect();
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const gap = 8;
  const maxX = window.innerWidth / zoom;
  const maxY = window.innerHeight / zoom;
  const x = (event.clientX || target?.left || 12) / zoom;
  const y = (event.clientY || target?.bottom || 90) / zoom;
  contextPosition.value = {
    left: `${Math.max(gap, Math.min(x, maxX - 240))}px`,
    top: `${Math.max(gap, y)}px`,
  };
  await nextTick();
  const popup = contextEl.value;
  if (!popup || context.value !== row) return;
  const height = popup.getBoundingClientRect().height / zoom;
  contextPosition.value = {
    ...contextPosition.value,
    top: `${Math.max(gap, Math.min(y, maxY - height - gap))}px`,
  };
  popup.focus({ preventScroll: true });
}
function closeContext(restoreFocus = true) {
  context.value = null;
  if (restoreFocus) contextTrigger?.focus({ preventScroll: true });
  contextTrigger = null;
}
const displayed = computed(() =>
  visible.value.filter(
    (row) =>
      tab.value === "messages" ||
      row.type === (tab.value === "friends" ? "direct" : "group") ||
      (tab.value === "groups" && row.type === "channel"),
  ),
);
const sections = computed(() =>
  tab.value === "messages"
    ? [{ id: 0, name: "", collapsed: false, items: displayed.value }]
    : [
        ...folders.value
          .filter(
            (folder) =>
              folder.scope === (tab.value === "friends" ? "direct" : "groups"),
          )
          .map((folder) => ({
            ...folder,
            items: displayed.value.filter((row) => row.folder_id === folder.id),
          })),
        {
          id: 0,
          name: "未分组",
          collapsed: ungrouped.value,
          items: displayed.value.filter((row) => !row.folder_id),
        },
      ],
);
async function action(kind: string) {
  const row = context.value;
  closeContext();
  if (!row) return;
  try {
    if (kind === "detach") return await chat.openDetached(row);
    if (kind === "folder") {
      folderTarget.value = row;
      folderId.value = row.folder_id || 0;
      return;
    }
    if (kind === "profile") {
      if (row.type === "direct") {
        chat.contactId.value = row.peer_user_id;
        chat.contactCard.value = null;
        chat.contactContext.value = undefined;
        chat.panel.value = "contacts";
      } else {
        await chat.choose(row.id);
        chat.panel.value = "group";
      }
      return;
    }
    if (kind === "remark" && row.peer_user_id) {
      const value = prompt("修改备注名（留空恢复原昵称）", row.remark || "");
      if (value === null) return;
      await chat.post("/contacts/remark", {
        user_id: row.peer_user_id,
        remark: value.trim(),
      });
      void chat.refreshNames();
      await chat.loadDirectory();
      return;
    }
    if (kind === "share" && row.peer_user_id) {
      shareIds.clear();
      shareQuery.value = "";
      shareUser.value = row.peer_user_id;
      return;
    }
    if (kind === "pin" || kind === "mute" || kind === "archive")
      await chat.mutate("/conversations/settings", {
        conversation_id: row.id,
        [kind === "pin"
          ? "is_pinned"
          : kind === "mute"
            ? "notifications_muted"
            : "is_archived"]: !(kind === "pin"
          ? row.is_pinned
          : kind === "mute"
            ? row.notifications_muted
            : row.is_archived),
      });
    if (kind === "unread")
      await chat.mutate("/messages/mark-unread", { conversation_id: row.id });
    if (kind === "clear" && chat.me.value?.internal_staff === true && confirm("清空自己在此会话中的历史记录？")) {
      await chat.mutate("/messages/clear-history", {
        conversation_id: row.id,
        through_message_id: row.message_seq,
      });
      if (active.value?.id === row.id) await chat.choose(row.id);
    }
    if (kind === "hide" && chat.me.value?.internal_staff === true && confirm("从列表删除这个会话？"))
      await chat.mutate("/conversations/hide", { conversation_id: row.id });
  } catch (cause) {
    chat.error(cause);
  }
}
function newFolder() {
  folderName.value = "";
  newFolderOpen.value = true;
}
async function createFolder() {
  if (!folderName.value.trim() || folderBusy.value) return;
  folderBusy.value = true;
  try {
    await chat.mutate("/conversation-folders", {
      scope: tab.value === "friends" ? "direct" : "groups",
      name: folderName.value.trim(),
    });
    newFolderOpen.value = false;
  } catch (cause) {
    chat.error(cause);
  } finally {
    folderBusy.value = false;
  }
}
async function collapse(id: number, collapsed: boolean) {
  if (!id) {
    localStorage.setItem(
      "pulse_ungrouped_collapsed_" +
        (tab.value === "friends" ? "direct" : "groups"),
      collapsed ? "0" : "1",
    );
    window.dispatchEvent(new Event("pulse:preferences"));
    return;
  }
  try {
    await chat.mutate("/conversation-folders/toggle", {
      folder_id: id,
      scope: tab.value === "friends" ? "direct" : "groups",
      collapsed: !collapsed,
    });
  } catch (cause) {
    chat.error(cause);
  }
}
</script>
<template>
  <aside class="vue-sidebar" aria-label="会话列表">
    <header class="vue-sidebar-head">
      <h1 class="sidebar-title">{{ archived ? "已归档" : "消息" }}</h1>
      <div class="vue-sidebar-tools flex items-center gap-2">
        <div class="sidebar-search">
          <UiIcon name="search" />
          <input
            v-model="search"
            aria-label="搜索会话"
            placeholder="搜索会话"
          />
          <button
            v-if="search"
            type="button"
            class="ui-icon-button"
            aria-label="清除搜索"
            title="清除搜索"
            @click="search = ''"
          >
            <UiIcon name="close" />
          </button>
        </div>
        <button
          type="button"
          class="ui-icon-button sidebar-add"
          aria-label="添加联系人"
          title="添加联系人"
          @click="emit('addContact')"
        >
          <UiIcon name="plus" />
        </button>
      </div>
      <nav class="vue-tabs" aria-label="会话分类">
        <button
          v-for="item in ['messages', 'friends', 'groups'] as const"
          :key="item"
          type="button"
          :aria-current="tab === item ? 'page' : undefined"
          @click="tab = item"
        >
          {{ { messages: "全部", friends: "好友", groups: "群聊" }[item] }}
          <span
            v-if="item === 'messages' && chat.totalUnread.value"
            class="unread"
            >{{
              chat.totalUnread.value > 99 ? "99+" : chat.totalUnread.value
            }}</span
          >
        </button>
      </nav>
      <button
        type="button"
        class="ui-icon-button sidebar-archive"
        :aria-label="archived ? '返回未归档对话' : '已归档对话'"
        :title="archived ? '返回未归档对话' : '已归档对话'"
        :aria-pressed="archived"
        @click="archived = !archived"
      >
        <UiIcon :name="archived ? 'back' : 'archive'" />
      </button>
    </header>
    <div
      v-if="tab !== 'messages'"
      class="conversation-section-tools"
      role="group"
      aria-label="会话工具"
    >
      <button
        v-if="tab === 'groups'"
        type="button"
        class="ui-icon-button"
        aria-label="创建群聊"
        title="创建群聊"
        @click="chat.panel.value = 'create-group'"
      >
        <UiIcon name="plus" />
      </button>
      <button
        v-if="tab === 'groups'"
        type="button"
        class="ui-icon-button"
        aria-label="加入群聊"
        title="加入群聊"
        @click="chat.panel.value = 'join'"
      >
        <UiIcon name="link" />
      </button>
      <button
        type="button"
        class="ui-icon-button"
        aria-label="添加分组"
        title="添加分组"
        @click="newFolder"
      >
        <UiIcon name="folder" />
      </button>
    </div>
    <div class="conversation-list">
      <section v-for="section in sections" :key="section.id">
        <button
          v-if="section.name"
          type="button"
          class="vue-folder"
          :aria-expanded="!section.collapsed"
          @click="collapse(section.id, section.collapsed)"
        >
          <UiIcon :name="section.collapsed ? 'chevron' : 'down'" />
          <span class="folder-label">{{ section.name }}</span><small>{{
            section.items.length
          }}</small>
        </button>
        <template v-if="!section.collapsed">
          <ConversationRow
            v-for="row in section.items"
            :key="row.id"
            :row="row"
            :selected="active?.id === row.id"
            :draft="chat.drafts.value[row.id]"
            @open="openConversation(row.id)"
            @menu="openContext(row, $event)"
          />
        </template>
      </section>
      <div v-if="!displayed.length" class="conversation-empty">
        <UiIcon :name="archived ? 'archive' : search ? 'search' : 'chat'" />
        <span>{{
          search ? "没有匹配的会话" : archived ? "暂无归档会话" : "暂无会话"
        }}</span>
      </div>
    </div>
  </aside>
  <Teleport to="body" v-if="context">
    <div
      class="workspace-menu-shield"
      aria-hidden="true"
      @click="closeContext(false)"
    ></div>
    <div
      ref="contextEl"
      tabindex="-1"
      :style="contextPosition"
      class="vue-side-menu vue-context"
      role="group"
      aria-label="会话操作"
      @keydown.esc.stop="closeContext()"
    >
      <button v-if="platform.chatWindows && context.type !== 'favorites'" @click="action('detach')">
        独立窗口
      </button>
      <button @click="action('pin')">
        {{ context.is_pinned ? "取消置顶" : "置顶" }}</button><button
        @click="action('mute')"
      >
        {{
          context.notifications_muted ? "开启消息通知" : "关闭消息通知"
        }}</button
      ><button @click="action('archive')">
        {{ context.is_archived ? "移出归档" : "归档对话" }}</button
      ><button @click="action('profile')">查看资料</button
      ><button v-if="context.type === 'direct'" @click="action('share')">
        分享好友名片</button
      ><button v-if="context.type === 'direct'" @click="action('remark')">
        修改备注名</button
      ><button @click="action('folder')">移入分组</button
      ><button @click="action('unread')">标记为未读</button
      ><button v-if="chat.me.value?.internal_staff === true" @click="action('clear')">清空历史记录</button
      ><button v-if="chat.me.value?.internal_staff === true && context.type === 'direct'" @click="action('hide')">
        删除会话</button
      ><button @click="closeContext()">关闭</button>
    </div>
  </Teleport>
  <BaseDialog
    v-if="folderTarget"
    title="移入分组"
    :busy="folderBusy"
    @close="folderTarget = null"
    ><form @submit.prevent="assignFolder">
      <label
        >分组<select v-model.number="folderId">
          <option :value="0">未分组</option>
          <option
            v-for="folder in folders.filter(
              (item) =>
                item.scope ===
                (folderTarget?.type === 'direct' ? 'direct' : 'groups'),
            )"
            :key="folder.id"
            :value="folder.id"
          >
            {{ folder.name }}
          </option>
        </select></label
      ><button class="primary" :disabled="folderBusy">保存</button>
    </form></BaseDialog
  >
  <BaseDialog
    v-if="newFolderOpen"
    title="添加分组"
    :busy="folderBusy"
    @close="newFolderOpen = false"
    ><form @submit.prevent="createFolder">
      <label
        >分组名称<input v-model="folderName" maxlength="64" required /></label
      ><button class="primary" :disabled="folderBusy">保存</button>
    </form></BaseDialog
  >
  <BaseDialog
    v-if="shareUser"
    title="分享好友名片"
    :busy="folderBusy"
    @close="shareUser = null"
    ><input
      v-model="shareQuery"
      aria-label="搜索接收者"
      placeholder="搜索接收者"
    /><button
      v-for="target in shareTargets"
      :key="target.id"
      :disabled="folderBusy"
      @click="share(target.id)"
    >
      {{ target.name }}
    </button></BaseDialog
  >
</template>

<style scoped>
.vue-sidebar {
  grid-area: 1 / 2 / -1 / 3;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-inline-end: 1px solid var(--ui-line);
  background: var(--workspace-list-surface, var(--ui-sidebar));
}
.vue-sidebar-head {
  display: grid;
  grid-template-areas: "title archive" "search search" "tabs tabs";
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 8px;
  padding: 12px 14px 0;
}
.sidebar-title {
  grid-area: title;
  margin: 0;
  font-size: var(--ui-font-heading);
  font-weight: var(--ui-weight-strong);
  line-height: var(--ui-line-heading);
}
.vue-sidebar-head .sidebar-archive {
  grid-area: archive;
  margin-inline-start: auto;
  font-size: 17px;
}
.vue-sidebar-tools {
  grid-area: search;
  margin-block-start: 10px;
}
.vue-sidebar-head .vue-tabs {
  grid-area: tabs;
  align-self: stretch;
  gap: 0;
  margin-block-start: 6px;
  padding: 0;
  border-bottom: 1px solid var(--ui-line);
  border-radius: 0;
  background: transparent;
}
.vue-sidebar-head .vue-tabs button {
  position: relative;
  min-height: 40px;
  padding-inline: 0;
  border-radius: 0;
  font-size: var(--ui-font-control);
  box-shadow: none;
}
.vue-sidebar-head .vue-tabs button[aria-current="page"] {
  background: transparent;
}
.vue-tabs button[aria-current="page"]::after {
  position: absolute;
  bottom: -1px;
  inset-inline: 26%;
  height: 2px;
  border-radius: 2px;
  background: var(--ui-primary);
  content: "";
}
.sidebar-search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1;
  padding-inline: 10px 4px;
  height: 38px;
  border-radius: 9px;
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--ui-fill) 76%, var(--ui-surface));
  color: var(--ui-muted);
}
.sidebar-search:focus-within {
  border-color: var(--ui-focus);
  background: var(--ui-surface);
}
.sidebar-search input {
  min-width: 0;
  width: 100%;
  padding: 0;
  border: 0;
  outline: none;
  color: var(--ui-text);
  background: transparent;
  font-size: var(--ui-font-control);
}
.sidebar-search input:focus-visible {
  outline: none;
}
.sidebar-search .ui-icon-button {
  width: 25px;
  height: 25px;
}
.vue-sidebar-head .sidebar-add {
  width: 38px;
  height: 38px;
  border: 1px solid var(--ui-line);
  border-radius: 9px;
  background: var(--ui-surface);
  font-size: 18px;
}
.conversation-section-tools {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  padding: 6px 14px 0;
}
.conversation-section-tools .ui-icon-button {
  width: 32px;
  height: 32px;
}
.conversation-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding: 8px 8px 12px;
}
.conversation-list .vue-folder {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 32px;
  margin: 2px 0;
  background: transparent;
  padding: 6px 7px;
  text-align: start;
  color: var(--ui-muted);
  font-size: 12px;
}
.folder-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.conversation-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 6px;
  color: var(--ui-muted);
  font-size: 13px;
}
.conversation-empty .ui-icon {
  font-size: 27px;
}
.vue-side-menu.vue-context {
  width: min(232px, calc(100vw - 16px));
  max-height: min(430px, calc(100dvh - 24px));
}
.vue-context button {
  min-height: 32px;
  padding: 5px 9px;
}

@media (max-width: 760px) {
  .vue-sidebar {
    grid-area: 2 / 1;
    border: 0;
  }
  .vue-sidebar-head {
    grid-template-areas: "search search" "tabs archive";
    padding: 0 14px;
  }
  .sidebar-title {
    display: none;
  }
  .vue-sidebar-tools {
    margin-block-start: 0;
  }
  .vue-sidebar-head .sidebar-archive {
    align-self: end;
    height: 40px;
  }
}
</style>
