<script setup lang="ts">
import { computed, inject, onScopeDispose, shallowRef, watch } from "vue";
import { chatKey } from "../../composables/useChat";
import BaseDialog from "../../components/BaseDialog.vue";
import AvatarImage from "../../components/AvatarImage.vue";
import type {
  Conversation,
  FriendRequest,
  Page,
  Profile,
} from "../../api/types";
const props = defineProps<{
  userId?: number;
  card?: { conversation: number; message: number } | null;
  contextId?: number;
}>();
const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const mode = shallowRef<"friends" | "search" | "requests" | "blocked">(
    "friends",
  ),
  keyword = shallowRef(""),
  contacts = shallowRef<Profile[]>([]),
  requests = shallowRef<FriendRequest[]>([]);
const profile = shallowRef<Profile | null>(null),
  common = shallowRef<Conversation[]>([]),
  remark = shallowRef(""),
  groupName = shallowRef(""),
  busy = shallowRef(false),
  page = shallowRef(1),
  hasMore = shallowRef(false),
  staffDetails = shallowRef<Record<string, unknown> | null>(null);
const clearedKey = "pulse_vue_friend_requests_cleared:" + chat.me.value?.id;
const cleared = shallowRef<number[]>([]);
try {
  const value = JSON.parse(localStorage.getItem(clearedKey) || "[]");
  if (Array.isArray(value)) cleared.value = value.filter(Number.isSafeInteger);
} catch {}
const visibleRequests = computed(() =>
  requests.value.filter(
    (row) => row.status === "pending" && !cleared.value.includes(row.id),
  ),
);
function clearRequests() {
  cleared.value = [
    ...new Set([
      ...cleared.value,
      ...visibleRequests.value.map((row) => row.id),
    ]),
  ].slice(-300);
  localStorage.setItem(clearedKey, JSON.stringify(cleared.value));
}
let revision = 0;
const abort = new AbortController();
const sorted = computed(() =>
  [...contacts.value]
    .filter(
      (row) =>
        mode.value === "search" ||
        !keyword.value ||
        (row.nickname + row.username + row.public_id + (row.remark || ""))
          .toLowerCase()
          .includes(keyword.value.toLowerCase()),
    )
    .sort((a, b) =>
      (a.remark || a.nickname).localeCompare(b.remark || b.nickname, "zh-CN"),
    ),
);
async function load(append = false) {
  const mine = ++revision;
  busy.value = true;
  if (!append) page.value = 1;
  try {
    if (mode.value === "requests")
      requests.value = (
        await chat.api<Page<FriendRequest>>(
          "/contact-requests?direction=received&size=100",
        )
      ).items;
    else if (mode.value === "blocked") {
      const blocks =
        await chat.api<Page<{ blocked_id: number; nickname: string }>>(
          "/blocks",
        );
      contacts.value = blocks.items.map(
        (row) =>
          ({
            id: row.blocked_id,
            user_id: row.blocked_id,
            nickname: row.nickname,
          }) as Profile,
      );
    } else {
      const result = await chat.api<Page<Profile>>(
        mode.value === "search"
          ? "/contacts/search?q=" + encodeURIComponent(keyword.value)
          : `/contacts?page=${page.value}&size=100`,
        { signal: abort.signal },
      );
      if (mine !== revision) return;
      contacts.value = append
        ? [...contacts.value, ...result.items]
        : result.items;
      hasMore.value =
        result.items.length === 100 &&
        (result.total == null || contacts.value.length < result.total);
    }
  } catch (cause) {
    if (mine === revision) chat.error(cause);
  } finally {
    if (mine === revision) busy.value = false;
  }
}
async function detail(id: number) {
  const mine = ++revision;
  busy.value = true;
  try {
    const result = await chat.api<Profile>(
      props.card
        ? `/contacts/card-profile?conversation_id=${props.card.conversation}&message_id=${props.card.message}`
        : "/contacts/profile?user_id=" +
            id +
            (props.contextId
              ? "&context_conversation_id=" + props.contextId
              : ""),
    );
    if (mine !== revision) return;
    profile.value = result;
    remark.value = result.remark || "";
    groupName.value = result.group_name || "";
    staffDetails.value = null;
    const commonResult = (
      await chat.api<Page<Conversation>>(
        "/contacts/common-groups?user_id=" +
          id +
          (props.contextId
            ? "&context_conversation_id=" + props.contextId
            : ""),
      )
    ).items;
    if (mine !== revision) return;
    common.value = commonResult;
    if (chat.me.value?.internal_staff) {
      const details = await chat.api<Record<string, unknown>>(
        "/contacts/internal-profile?user_id=" +
          id +
          (props.contextId
            ? "&context_conversation_id=" + props.contextId
            : ""),
      );
      if (mine === revision) staffDetails.value = details;
    }
  } catch (cause) {
    if (mine === revision) chat.error(cause);
  } finally {
    if (mine === revision) busy.value = false;
  }
}
async function operation(action: string, target: number) {
  if (busy.value) return;
  busy.value = true;
  try {
    if (action === "chat") {
      const row = await chat.post<Conversation>("/conversations/direct", {
        user_id: target,
      });
      await chat.choose(row.id);
      emit("close");
    }
    if (action === "request") {
      const note = prompt("好友验证信息");
      if (note === null) return;
      await chat.post("/contact-requests", {
        to_user_id: target,
        message: note,
        ...(props.contextId
          ? { context_conversation_id: props.contextId }
          : {}),
        ...(props.card
          ? {
              card_conversation_id: props.card.conversation,
              card_message_id: props.card.message,
            }
          : {}),
      });
    }
    if (action === "force")
      await chat.post("/contacts/force-add", { user_id: target });
    if (action === "remove" && confirm("删除这个好友？"))
      await chat.post("/contacts/remove", { user_id: target });
    if (action === "block" && confirm("拉黑这个用户？"))
      await chat.post("/blocks", { user_id: target, reason: "用户操作" });
    if (action === "unblock")
      await chat.post("/blocks/unblock", { user_id: target });
    if (action === "remark")
      await chat.post("/contacts/remark", {
        user_id: target,
        remark: remark.value,
        group_name: groupName.value,
      });
    if (action === "accept" || action === "reject")
      await chat.post("/contact-requests/handle", {
        request_id: target,
        action,
      });
    if (action !== "chat") {
      profile.value = null;
      await load();
      void chat.loadDirectory();
      void chat.refreshNames();
      void chat.refreshNotificationCount();
    }
  } catch (cause) {
    chat.error(cause);
  } finally {
    busy.value = false;
  }
}
watch(mode, () => {
  profile.value = null;
  void load();
});
if (props.userId) void detail(props.userId);
else void load();
onScopeDispose(() => {
  revision++;
  abort.abort();
});
</script>
<template>
  <BaseDialog
    :title="profile ? '个人资料' : '联系人'"
    :size="profile ? 'compact' : undefined"
    @close="emit('close')"
  >
    <template v-if="profile"
      ><button @click="profile = null">返回联系人</button
      ><AvatarImage :name="profile.nickname" :src="profile.avatar_url" />
      <h3>{{ profile.nickname }}</h3>
      <p v-if="profile.add_friend_restriction" role="status">
        {{ profile.add_friend_restriction }}
      </p>
      <dl class="vue-details">
        <dt>账号</dt>
        <dd>{{ profile.username || "未公开" }}</dd>
        <dt>用户 ID</dt>
        <dd>{{ profile.public_id }}</dd>
        <dt>数字 ID</dt>
        <dd>{{ profile.id }}</dd>
        <dt>个性签名</dt>
        <dd>{{ profile.signature }}</dd>
        <dt>状态</dt>
        <dd>
          {{
            profile.last_seen_hidden
              ? "最近上线已隐藏"
              : profile.online
                ? "在线"
                : profile.last_seen_at || "离线"
          }}
        </dd>
      </dl>
      <label
        >备注<input v-model="remark" :disabled="!profile.is_contact" /></label
      ><label
        >好友分组<input v-model="groupName" :disabled="!profile.is_contact"
      /></label>
      <div class="vue-action-list">
        <button
          :disabled="busy || !profile.is_contact"
          @click="operation('remark', profile.id)"
        >
          保存备注</button
        ><button :disabled="busy" @click="operation('chat', profile.id)">
          发送消息 / 临时聊天</button
        ><button
          v-if="!profile.is_contact"
          :disabled="busy || profile.can_add_friend === false"
          @click="operation('request', profile.id)"
        >
          添加好友</button
        ><button
          v-if="chat.me.value?.internal_staff && !profile.is_contact"
          :disabled="busy"
          @click="operation('force', profile.id)"
        >
          直接添加好友</button
        ><button
          v-if="profile.is_contact"
          :disabled="busy"
          @click="operation('remove', profile.id)"
        >
          删除好友</button
        ><button
          :disabled="busy"
          @click="
            operation(profile.blocked_by_me ? 'unblock' : 'block', profile.id)
          "
        >
          {{ profile.blocked_by_me ? "解除屏蔽" : "拉黑好友" }}
        </button>
      </div>
      <h4>共同群组</h4>
      <button
        v-for="group in common"
        :key="group.id"
        @click="
          chat.choose(group.id);
          emit('close');
        "
      >
        {{ group.name }}
      </button>
      <details v-if="staffDetails">
        <summary>内部人员资料</summary>
        <dl class="vue-details">
          <template v-for="(value, key) in staffDetails" :key="key"
            ><dt>{{ key }}</dt>
            <dd>
              {{ typeof value === "object" ? JSON.stringify(value) : value }}
            </dd></template
          >
        </dl>
      </details></template
    >
    <template v-else
      ><nav class="vue-tabs">
        <button
          v-for="item in ['friends', 'search', 'requests', 'blocked'] as const"
          :key="item"
          :aria-current="mode === item ? 'page' : undefined"
          @click="mode = item"
        >
          {{
            {
              friends: "我的好友",
              search: "添加好友",
              requests: "好友验证",
              blocked: "黑名单",
            }[item]
          }}
        </button>
      </nav>
      <form class="vue-panel-search" @submit.prevent="load()">
        <input
          v-model="keyword"
          aria-label="搜索联系人"
          placeholder="昵称、用户名或手机号"
        /><button v-if="mode === 'search'" :disabled="busy">搜索</button>
      </form>
      <p v-if="busy" role="status">加载中…</p>
      <template v-if="mode === 'requests'"
        ><button
          @click="clearRequests"
          :disabled="busy || !visibleRequests.length"
        >
          清除通知
        </button>
        <p v-if="!busy && !visibleRequests.length">暂无新的朋友通知</p>
        <article
          v-for="row in visibleRequests"
          :key="row.id"
          class="vue-contact-row"
        >
          <strong>{{ row.nickname }}</strong><span>{{ row.message }}</span
          ><button
            :disabled="busy || row.status !== 'pending'"
            @click="operation('accept', row.id)"
          >
            同意</button
          ><button
            :disabled="busy || row.status !== 'pending'"
            @click="operation('reject', row.id)"
          >
            拒绝
          </button>
        </article></template
      ><template v-else
        ><article v-for="row in sorted" :key="row.id" class="vue-contact-row">
          <AvatarImage
            :name="row.remark || row.nickname"
            :src="row.avatar_url"
          /><button @click="detail(row.id)">
            {{ row.remark || row.nickname
            }}<small>{{ row.username }}</small></button
          ><button
            v-if="mode === 'blocked'"
            :disabled="busy"
            @click="operation('unblock', row.id)"
          >
            解除屏蔽</button
          ><button
            v-else
            :disabled="busy"
            @click="operation(mode === 'search' ? 'request' : 'chat', row.id)"
          >
            {{ mode === "search" ? "加好友" : "发消息" }}
          </button>
        </article>
        <button
          v-if="hasMore && mode === 'friends'"
          :disabled="busy"
          @click="
            page++;
            load(true);
          "
        >
          加载更多
        </button></template
      >
      <p v-if="!busy && !contacts.length && mode !== 'requests'">
        暂无联系人
      </p></template
    >
  </BaseDialog>
</template>
