<script setup lang="ts">
import { computed, inject, shallowRef, watch } from "vue";
import { chatKey } from "../../composables/useChat";
import BaseDialog from "../../components/BaseDialog.vue";
import { usePreferences } from "../../composables/usePreferences";
import AvatarImage from "../../components/AvatarImage.vue";
import { textOf, type Conversation } from "../../api/types";
const emit = defineEmits<{ open: [] }>();
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
const { me, active, folders, visible, tab, archived, search } = chat;
const preferences = usePreferences();
const isNight = computed(() => {
  void preferences.revision.value;
  return document.body.dataset.theme === "night";
});
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
function night() {
  const current = localStorage.getItem("pulse_chat_theme") || "classic";
  const next =
    current === "night"
      ? localStorage.getItem("pulse_chat_light_theme") || "classic"
      : "night";
  if (current !== "night")
    localStorage.setItem("pulse_chat_light_theme", current);
  localStorage.setItem("pulse_chat_theme", next);
  document.body.dataset.theme = next;
  document.body.classList.toggle("desktop-night-mode", next === "night");
  document.documentElement.style.colorScheme =
    next === "night" ? "dark" : "light";
  window.dispatchEvent(new Event("pulse:preferences"));
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

const menu = shallowRef(false),
  context = shallowRef<Conversation | null>(null);
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
  context.value = null;
  if (!row) return;
  try {
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
    if (kind === "clear" && confirm("清空自己在此会话中的历史记录？")) {
      await chat.mutate("/messages/clear-history", {
        conversation_id: row.id,
        through_message_id: row.message_seq,
      });
      if (active.value?.id === row.id) await chat.choose(row.id);
    }
    if (kind === "hide" && confirm("从列表删除这个会话？"))
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
async function saved() {
  try {
    const row = await chat.post<Conversation>("/conversations/favorites", {});
    await chat.choose(row.id);
  } catch (cause) {
    chat.error(cause);
  }
  menu.value = false;
}
</script>
<template>
  <aside class="vue-sidebar">
    <header class="vue-sidebar-head">
      <div class="vue-sidebar-tools">
        <button aria-label="打开菜单" @click="menu = !menu">☰</button
        ><input
          v-model="search"
          aria-label="搜索会话"
          placeholder="搜索"
        /><button
          aria-label="添加联系人"
          @click="chat.panel.value = 'contacts'"
        >
          ＋
        </button>
      </div>
      <nav class="vue-tabs" aria-label="会话分类">
        <button
          v-for="item in ['messages', 'friends', 'groups'] as const"
          :key="item"
          :aria-current="tab === item ? 'page' : undefined"
          @click="tab = item"
        >
          {{ { messages: "聊天", friends: "好友", groups: "群聊" }[item] }}
          <span
            v-if="item === 'messages' && chat.totalUnread.value"
            class="unread"
            >{{
              chat.totalUnread.value > 99 ? "99+" : chat.totalUnread.value
            }}</span
          >
        </button>
      </nav>
    </header>
    <div v-if="menu" class="vue-side-menu">
      <strong>{{ me?.nickname }}</strong><button
        @click="
          chat.panel.value = 'create-group';
          menu = false;
        "
      >
        新建群组</button
      ><button
        @click="
          chat.panel.value = 'create-channel';
          menu = false;
        "
      >
        新建频道</button
      ><button
        @click="
          chat.panel.value = 'join';
          menu = false;
        "
      >
        加入群聊 / 频道</button
      ><button
        @click="
          chat.panel.value = 'contacts';
          menu = false;
        "
      >
        联系人</button
      ><button @click="saved">我的收藏</button
      ><button
        @click="
          chat.panel.value = 'qr';
          menu = false;
        "
      >
        我的二维码</button
      ><button
        @click="
          chat.panel.value = 'notifications';
          menu = false;
        "
      >
        消息中心
        <span v-if="chat.notificationUnread.value"
          >({{ chat.notificationUnread.value }})</span
        ></button
      ><button
        v-if="me?.internal_staff"
        @click="
          chat.panel.value = 'broadcast';
          menu = false;
        "
      >
        群发任务</button
      ><button
        @click="
          chat.panel.value = 'calls';
          menu = false;
        "
      >
        通话记录</button
      ><button
        @click="
          chat.panel.value = 'settings';
          menu = false;
        "
      >
        设置</button
      ><button role="switch" :aria-checked="isNight" @click="night">
        夜间模式</button
      ><button disabled title="当前服务没有翻译接口">
        自动翻译（暂未开放）</button
      ><small>版本 2.4.192</small><button @click="chat.logout">退出登录</button>
    </div>
    <div v-if="tab === 'groups'" class="vue-sidebar-actions">
      <button @click="chat.panel.value = 'create-group'">创建群聊</button
      ><button @click="chat.panel.value = 'join'">加入群聊</button>
    </div>
    <div class="vue-sidebar-actions">
      <button @click="archived = !archived">
        {{ archived ? "返回未归档对话" : "已归档对话" }}</button><button
        v-if="tab !== 'messages'"
        @click="newFolder"
      >
        添加分组
      </button>
    </div>
    <div class="conversation-list">
      <section v-for="section in sections" :key="section.id">
        <button
          v-if="section.name"
          class="vue-folder"
          @click="collapse(section.id, section.collapsed)"
        >
          {{ section.collapsed ? "›" : "⌄" }} {{ section.name }}
          {{ section.items.length }}</button
        ><template v-if="!section.collapsed"
          ><button
            v-for="row in section.items"
            :key="row.id"
            class="conversation"
            :class="{ active: active?.id === row.id }"
            @click="openConversation(row.id)"
            @contextmenu.prevent="context = row"
          >
            <AvatarImage :name="row.name" :src="row.avatar_url" /><span
              class="vue-conversation-copy"
              ><strong>{{ row.is_pinned ? "⌃ " : "" }}{{ row.name }}</strong
              ><small
                >{{ row.notifications_muted ? "静音 · " : ""
                }}{{
                  chat.drafts.value[row.id]
                    ? "草稿：" + chat.drafts.value[row.id]
                    : textOf(row.last_message)
                }}</small
              ></span
            ><span v-if="row.unread_count" class="unread"
              >{{ row.unread_mention_count ? "@ " : ""
              }}{{ row.unread_count > 99 ? "99+" : row.unread_count }}</span
            >
          </button></template
        >
      </section>
      <p v-if="!displayed.length" class="empty">暂无会话</p>
    </div>
    <footer class="vue-profile">
      <AvatarImage :name="me?.nickname" :src="me?.avatar_url" /><button
        @click="chat.panel.value = 'settings'"
      >
        {{ me?.nickname }}<small>账户设置</small>
      </button>
    </footer>
    <div
      v-if="context"
      class="vue-side-menu vue-context"
      role="menu"
      aria-label="会话操作"
      @keydown.esc="context = null"
    >
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
      ><button @click="action('clear')">清空历史记录</button
      ><button v-if="context.type === 'direct'" @click="action('hide')">
        删除会话</button
      ><button @click="context = null">关闭</button>
    </div>
  </aside>
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
