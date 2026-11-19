<script setup lang="ts">
import {
  computed,
  inject,
  onScopeDispose,
  shallowRef,
  reactive,
  watch,
} from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import AvatarImage from "../../components/AvatarImage.vue";
import UiIcon from "../../components/UiIcon.vue";
import GroupMemberMenu from "./GroupMemberMenu.vue";
import { chatKey } from "../../composables/useChat";

import type {
  Conversation,
  Group,
  Member,
  Page,
  Profile,
} from "../../api/types";
const props = defineProps<{
  mode: "group" | "create-group" | "create-channel" | "join";
  inline?: boolean;
}>();
const emit = defineEmits<{ close: []; updated: [] }>();
const chat = inject(chatKey)!;
const client = chat.client;
const navigator = window.navigator;
const group = shallowRef<Group | null>(null),
  name = shallowRef(""),
  description = shallowRef(""),
  announcement = shallowRef(""),
  code = shallowRef(""),
  number = shallowRef(""),
  joinChannel = shallowRef(false),
  blockFriends = shallowRef(false),
  allowHistory = shallowRef(false);
const members = shallowRef<Member[]>([]),
  candidates = shallowRef<Profile[]>([]),
  selected = shallowRef<number[]>([]),
  query = shallowRef(""),
  page = shallowRef(1),
  hasMore = shallowRef(false),
  busy = shallowRef(false),
  inviteMode = shallowRef(false),
  avatar = shallowRef<File | undefined>();
const candidatePage = shallowRef(1),
  candidateMore = shallowRef(false),
  candidateQuery = shallowRef(""),
  candidateLoading = shallowRef(false),
  candidateError = shallowRef("");
const queries = reactive({ pinned: "", recent: "" });
const candidateVisible = computed(() => {
  const people = new Map(candidates.value.map((row) => [row.id, row]));
  if (props.mode === "create-group")
    for (const row of chat.conversations.value)
      if (
        row.type === "direct" &&
        row.peer_user_id &&
        !people.has(row.peer_user_id)
      )
        people.set(row.peer_user_id, {
          id: row.peer_user_id,
          user_id: row.peer_user_id,
          nickname: row.name,
          username: "",
          public_id: "",
          signature: "",
          avatar_url: row.avatar_url || "",
        });
  const time = (user: number) =>
    chat.conversations.value.find((row) => row.peer_user_id === user)
      ?.updated_at || "";
  return [...people.values()]
    .filter(
      (row) =>
        row.id !== chat.me.value?.id &&
        (!candidateQuery.value ||
          [row.nickname, row.username, row.remark, row.public_id]
            .join(" ")
            .toLowerCase()
            .includes(candidateQuery.value.toLowerCase())),
    )
    .sort((a, b) => time(b.id).localeCompare(time(a.id)) || a.id - b.id);
});
const pinnedIds = computed(
  () =>
    new Set(
      chat.conversations.value
        .filter((row) => row.type === "direct" && row.is_pinned)
        .map((row) => row.peer_user_id),
    ),
);
const candidateSections = computed(() =>
  [
    {
      kind: "pinned" as const,
      name: "置顶用户列表",
      items: candidateVisible.value.filter((row) =>
        pinnedIds.value.has(row.id),
      ),
    },
    {
      kind: "recent" as const,
      name: "最新消息用户列表",
      items: candidateVisible.value.filter(
        (row) => !pinnedIds.value.has(row.id),
      ),
    },
  ].map((section) => ({
    ...section,
    items: section.items.filter((row) =>
      [row.nickname, row.username, row.remark, row.public_id]
        .join(" ")
        .toLowerCase()
        .includes(queries[section.kind].toLowerCase()),
    ),
  })),
);
const capacity = computed(() =>
  Math.max(
    0,
    (group.value?.member_limit ||
      chat.config.value?.group_member_limit ||
      500) - (group.value?.member_count || 1),
  ),
);
function selectSection(rows: Profile[]) {
  const ids = new Set(selected.value);
  if (rows.length && rows.every((row) => ids.has(row.id)))
    for (const row of rows) ids.delete(row.id);
  else
    for (const row of rows) {
      if (ids.size >= capacity.value) break;
      ids.add(row.id);
    }
  selected.value = [...ids];
}
const presets = [
  ["护盾", "#42c5b5", "M20 8 9 12v9c0 8 11 13 11 13s11-5 11-13v-9Z"],
  ["笑脸", "#6784f0", "M20 9a12 12 0 1 0 0 24 12 12 0 0 0 0-24Z"],
  [
    "气泡",
    "#a260df",
    "M8 19a12 12 0 0 1 24 0c0 7-6 12-13 12l-8 4 1-7a12 12 0 0 1-4-9Z",
  ],
  ["火箭", "#ea77aa", "M15 14c4-6 10-7 16-6 1 6-1 12-7 16l-5-5Z"],
  [
    "灯泡",
    "#edb557",
    "M20 7a10 10 0 0 0-7 17c2 2 3 4 3 6h8c0-2 1-4 3-6a10 10 0 0 0-7-17Zm-4 26h8v3h-8Z",
  ],
] as const;
const preset = shallowRef(0);
let uploadedAvatar = "";
watch(avatar, () => {
  uploadedAvatar = "";
});
async function presetFile() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 160;
  const context = canvas.getContext("2d")!;
  context.scale(4, 4);
  context.fillStyle = presets[preset.value]![1];
  context.fillRect(0, 0, 40, 40);
  context.fillStyle = "#fff";
  context.fill(new Path2D(presets[preset.value]![2]));
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw Error("群头像生成失败");
  return new File([blob], "group-avatar.png", { type: "image/png" });
}
let disposed = false,
  revision = 0;
const id = chat.active.value?.id;
const title = computed(() =>
  props.mode === "join"
    ? "加入群组 / 频道"
    : props.mode === "create-channel"
      ? "新建频道"
      : props.mode === "create-group"
        ? "创建群聊"
        : "群组资料与成员管理",
);
async function load(append = false) {
  if (props.mode !== "group" || !id) return;
  const mine = ++revision;
  if (!append) page.value = 1;
  try {
    const info = await chat.api<Group>(
      "/conversations/groups/profile?conversation_id=" + id,
    );
    const roster = await chat.api<Page<Member>>(
      `/conversations/members?conversation_id=${id}&q=${encodeURIComponent(query.value)}&page=${page.value}`,
    );
    if (disposed || mine !== revision) return;
    group.value = info;
    if (!append) code.value = info.invite_code || "";
    name.value = info.name;
    description.value = info.description || "";
    announcement.value = info.announcement || "";
    blockFriends.value = info.allow_member_add_friend === false;
    members.value = append ? [...members.value, ...roster.items] : roster.items;
    hasMore.value = roster.has_more === true;
  } catch (cause) {
    if (!disposed) chat.error(cause);
  }
}
async function choices(append = false) {
  if (candidateLoading.value) return;
  candidateLoading.value = true;
  candidateError.value = "";
  if (!append) candidatePage.value = 1;
  try {
    if (props.mode === "create-group") {
      const rows: Profile[] = [];
      for (let page = 1; page <= 1000; page++) {
        const result = await chat.api<Page<Profile>>(
          "/contacts?size=100&page=" + page,
        );
        if (disposed) return;
        rows.push(...result.items);
        if (
          result.items.length < 100 ||
          (result.total != null && rows.length >= result.total)
        )
          break;
      }
      candidates.value = rows;
      candidateMore.value = false;
      return;
    }
    const result =
      props.mode === "group" && id
        ? await chat.api<Page<Profile>>(
            `/conversations/invite-candidates?conversation_id=${id}&q=${encodeURIComponent(candidateQuery.value)}&page=${candidatePage.value}&size=100`,
          )
        : await chat.api<Page<Profile>>(
            "/contacts?size=100&page=" + candidatePage.value,
          );
    if (!disposed) {
      candidates.value = append
        ? [...candidates.value, ...result.items]
        : result.items;
      candidateMore.value =
        result.has_more === true ||
        (result.items.length === 100 &&
          (result.total == null || candidates.value.length < result.total));
    }
  } catch (cause) {
    if (!disposed)
      candidateError.value =
        cause instanceof Error ? cause.message : "用户列表加载失败";
  } finally {
    candidateLoading.value = false;
  }
}
async function save() {
  if (
    busy.value ||
    (props.mode === "create-group" &&
      (candidateLoading.value || candidateError.value))
  )
    return;
  busy.value = true;
  try {
    let avatarUrl = "";
    if (avatar.value || props.mode === "create-group") {
      if (!uploadedAvatar)
        uploadedAvatar = (
          await client.uploadMedia(
            "avatar",
            avatar.value || (await presetFile()),
          )
        ).url;
      avatarUrl = uploadedAvatar;
    }
    if (props.mode === "join") {
      const row = await chat.post<Conversation>(
        joinChannel.value
          ? "/conversations/channels/follow"
          : "/conversations/groups/join",
        {
          ...(code.value ? { invite_code: code.value } : {}),
          ...(number.value
            ? {
                group_number: number.value,
                ...(joinChannel.value ? { conversation_id: number.value } : {}),
              }
            : {}),
        },
      );
      await chat.loadDirectory();
      await chat.choose(row.id);
      emit("close");
    } else if (props.mode.startsWith("create")) {
      const row = await chat.post<Conversation>(
        props.mode === "create-channel"
          ? "/conversations/channels"
          : "/conversations/groups",
        {
          name: name.value.trim(),
          description: description.value.trim(),
          member_ids: selected.value,
          allow_member_add_friend: !blockFriends.value,
          ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
        },
      );
      await chat.loadDirectory();
      await chat.choose(row.id);
      emit("close");
    } else {
      await chat.post("/conversations/groups/profile", {
        conversation_id: id,
        name: name.value,
        description: description.value,
        announcement: announcement.value,
        allow_member_add_friend: !blockFriends.value,
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      });
      emit("updated");
      await load();
      await chat.refresh();
    }
  } catch (cause) {
    chat.error(cause);
  } finally {
    busy.value = false;
  }
}
async function manage(action: string, member?: Member) {
  if (!id || busy.value) return;
  busy.value = true;
  try {
    const base = {
      conversation_id: id,
      ...(member ? { user_id: member.id } : {}),
    };
    if (member) {
      const fresh = await chat.api<{ profile: Group; items: Member[] }>(
        "/conversations/members/context?conversation_id=" +
          id +
          "&user_id=" +
          member.id,
      );
      if (
        !fresh.profile.can_manage ||
        !fresh.items.some((row) => row.id === member.id)
      )
        throw Error("成员权限已变化，请重新搜索");
      group.value = fresh.profile;
    }
    if (action === "role")
      await chat.post("/conversations/members/role", {
        ...base,
        role: member?.role === "admin" ? "member" : "admin",
      });
    if (action === "mute")
      await chat.post("/conversations/members/mute", {
        ...base,
        minutes: member?.is_muted
          ? 0
          : Number(prompt("禁言分钟，-1 为永久禁言", "10") || "0"),
      });
    if (action === "remove" && confirm("从群组移除此成员？"))
      await chat.post("/conversations/members/remove", base);
    if (action === "transfer" && confirm("转让群主给此成员？"))
      await chat.post("/conversations/groups/transfer", base);
    if (action === "all-muted")
      await chat.post("/conversations/groups/settings", {
        ...base,
        all_muted: !group.value?.all_muted,
      });
    if (
      action === "invite-code" &&
      confirm("生成新的邀请码会使旧码失效，继续？")
    ) {
      const result = await chat.post<{ invite_code: string }>(
        "/go/invite-code",
        base,
      );
      code.value = result.invite_code;
    }
    if (action === "invite") {
      const result: {
        items: { user_id: number; status: string; message?: string }[];
      } = { items: [] };
      const targets = [...selected.value];
      for (let start = 0; start < targets.length; start += 50) {
        const part = await chat.post<typeof result>(
          "/conversations/members/batch",
          {
            ...base,
            user_ids: targets.slice(start, start + 50),
            allow_history: allowHistory.value,
          },
        );
        if (disposed) return;
        result.items.push(...part.items);
        selected.value = selected.value.filter(
          (user) =>
            !part.items.some(
              (row) => row.user_id === user && row.status === "joined",
            ),
        );
      }
      const rejected = result.items.filter((item) => item.status !== "joined");
      if (rejected.length)
        chat.error(
          Error(
            rejected.map((item) => item.message || "邀请被拒绝").join("；"),
          ),
        );
      selected.value = rejected.map((item) => item.user_id);
      inviteMode.value = rejected.length > 0;
    }
    if (
      (action === "leave" || action === "dissolve") &&
      confirm(action === "leave" ? "退出此群？" : "解散此群？")
    ) {
      await chat.post(
        action === "leave"
          ? "/conversations/leave"
          : "/conversations/groups/dissolve",
        base,
      );
      chat.active.value = null;
      chat.messages.value = [];
      emit("close");
    }
    if (
      !disposed &&
      ["role", "mute", "remove", "transfer", "invite"].includes(action)
    )
      emit("updated");
    await load();
    await chat.loadDirectory();
  } catch (cause) {
    chat.error(cause);
  } finally {
    busy.value = false;
  }
}
function roleLabel(role?: string) {
  switch (role) {
    case "owner":
      return "群主";
    case "admin":
      return "管理员";
    case "member":
      return "成员";
    default:
      return role || "";
  }
}
if (props.mode === "group") void load();
else if (props.mode === "create-group") void choices();
onScopeDispose(() => {
  disposed = true;
  revision++;
});
</script>
<template>
  <BaseDialog
    :title="title"
    :size="mode === 'group' || mode === 'create-group' ? 'wide' : 'compact'"
    :busy="busy"
    :inline="inline"
    @close="emit('close')"
  >
    <header v-if="mode === 'group' && group" class="group-summary">
      <AvatarImage :name="group.name" :src="group.avatar_url" />
      <div class="min-w-0">
        <h3>{{ group.name }}</h3>
        <p v-if="group.member_count != null || group.my_role">
          <span v-if="group.member_count != null"
            >{{ group.member_count }} 位成员</span
          ><span v-if="group.my_role"
            >{{ group.member_count != null ? " · " : ""
            }}{{ roleLabel(group.my_role) }}</span
          >
        </p>
        <p>群号：{{ group.group_number || group.invite_code || "暂不可用" }}</p>
      </div>
    </header>
    <section v-if="mode === 'group' && group" class="group-members-section">
      <h3 class="panel-section-title">群成员</h3>
      <form class="vue-panel-search" @submit.prevent="load()">
        <input
          v-model="query"
          aria-label="搜索群成员"
          placeholder="搜索群成员"
        /><button type="submit"><UiIcon name="search" /> 搜索</button>
      </form>
      <article
        v-for="member in members"
        :key="member.id"
        class="vue-contact-row vue-group-member"
      >
        <AvatarImage :name="member.nickname" :src="member.avatar_url" /><span
          class="vue-group-person"
          ><button
            type="button"
            @click="
              chat.contactId.value = member.id;
              chat.contactCard.value = null;
              chat.contactContext.value = id;
              chat.panel.value = 'contacts';
            "
          >
            {{ member.nickname }}
          </button>
          <small
            >{{ roleLabel(member.role)
            }}{{ member.is_muted ? " · 已禁言" : "" }}</small
          ></span
        >
        <GroupMemberMenu
          v-if="
            group.can_manage &&
            member.id !== chat.me.value?.id &&
            member.role !== 'owner'
          "
          :member="member"
          :owner="group.is_owner === true"
          :busy="busy"
          @action="manage($event, member)"
        />
      </article>
      <button
        v-if="hasMore"
        @click="
          page++;
          load(true);
        "
      >
        加载更多成员
      </button>
    </section>
    <template v-if="mode === 'group' && group">
      <div class="vue-action-list group-actions">
        <button
          @click="
            chat
              .mutate('/conversations/groups/settings', {
                conversation_id: id,
                is_pinned: !group.is_pinned,
              })
              .then(() => load())
              .catch(chat.error)
          "
        >
          <UiIcon name="bookmark" />
          {{ group.is_pinned ? "取消置顶" : "置顶会话" }}</button
        ><button
          @click="
            navigator.clipboard
              .writeText(group.group_number || group.invite_code || '')
              .catch(chat.error)
          "
        >
          <UiIcon name="link" /> 复制群号
        </button>
        <button
          role="switch"
          aria-label="群通知"
          :aria-checked="!group.notifications_muted"
          @click="
            chat
              .mutate('/conversations/groups/settings', {
                conversation_id: id,
                notifications_muted: !group.notifications_muted,
              })
              .then(() => load())
              .catch(chat.error)
          "
        >
          <span>{{
            group.notifications_muted ? "通知已关闭" : "通知已开启"
          }}</span>
          <span class="ui-switch-visual" aria-hidden="true"></span></button
        ><button v-if="group.can_manage" @click="manage('all-muted')">
          {{ group.all_muted ? "解除全体禁言" : "全体禁言" }}</button
        ><button
          v-if="group.can_invite"
          @click="
            inviteMode = !inviteMode;
            choices();
          "
        >
          邀请好友</button
        ><button v-if="group.can_manage" @click="manage('invite-code')">
          生成邀请码</button
        ><button
          v-if="group.is_owner"
          class="vue-button-danger"
          @click="manage('dissolve')"
        >
          解散群组</button
        ><button v-else class="vue-button-danger" @click="manage('leave')">
          退出群组
        </button>
      </div>
      <label v-if="code"
        >邀请码<input :value="code" readonly /><button
          @click="navigator.clipboard.writeText(code)"
        >
          复制
        </button></label
      >
    </template>
    <h3 v-if="mode === 'group' && group" class="panel-section-title">群资料</h3>
    <form
      v-if="mode !== 'group' || group"
      class="vue-fields"
      :class="{ 'group-profile-fields': mode === 'group' }"
      @submit.prevent="save"
    >
      <template v-if="mode === 'join'"
        ><label><input v-model="joinChannel" type="checkbox" />加入频道</label
        ><label>邀请码<input v-model="code" /></label
        ><label>群号或频道编号<input v-model="number" /></label
      ></template>
      <template v-else
        ><label
          >名称<input
            v-model="name"
            required
            maxlength="128"
            :disabled="mode === 'group' && !group?.can_manage" /></label
        ><label v-if="mode !== 'group' || group?.can_manage"
          >头像<input
            type="file"
            :disabled="busy"
            accept="image/*"
            @change="
              avatar = ($event.target as HTMLInputElement).files?.[0]
            " /></label
        ><label v-if="mode === 'create-channel'"
          >简介<textarea
            v-model="description"
            maxlength="500"
          ></textarea></label
        ><template v-if="mode === 'group'"
          ><label
            >简介<textarea
              v-model="description"
              :disabled="!group?.can_manage"
            ></textarea></label
          ><label
            >公告<textarea
              v-model="announcement"
              :disabled="!group?.can_manage"
            ></textarea>
          </label> </template
        ><label v-if="mode === 'create-group' || group?.can_manage"
          ><input
            v-model="blockFriends"
            type="checkbox"
          />禁止群成员互加好友</label
        ></template
      >
      <button
        v-if="mode !== 'group' || group?.can_manage"
        class="primary"
        :disabled="
          busy ||
          (mode === 'create-group' && (candidateLoading || !!candidateError))
        "
      >
        {{ mode === "join" ? "加入" : mode === "group" ? "保存资料" : "创建" }}
      </button>
    </form>

    <section
      v-if="mode === 'create-group' || inviteMode"
      class="vue-group-candidates"
    >
      <div v-if="mode === 'create-group'" class="vue-preset-icons">
        <button
          v-for="([label, color, shape], index) in presets"
          :key="label"
          type="button"
          :disabled="busy"
          :aria-label="label + '群头像'"
          :aria-pressed="preset === index"
          @click="
            preset = index;
            avatar = undefined;
            uploadedAvatar = '';
          "
        >
          <svg viewBox="0 0 40 40" width="40" height="40">
            <rect width="40" height="40" rx="20" :fill="color" />
            <path :d="shape" fill="#fff" />
          </svg>
        </button>
      </div>
      <h3>选择好友</h3>
      <p v-if="candidateLoading" role="status">正在加载用户…</p>
      <p v-if="candidateError" role="alert">
        {{ candidateError }}<button @click="choices()">重试</button>
      </p>
      <form class="vue-panel-search" @submit.prevent="choices()">
        <input
          v-model="candidateQuery"
          aria-label="搜索可邀请好友"
          placeholder="搜索好友"
        /><button>搜索</button>
      </form>
      <button
        type="button"
        @click="
          selected = candidateVisible.slice(0, capacity).map((item) => item.id)
        "
      >
        全选</button
      ><button type="button" @click="selected = []">清空</button>
      <section v-for="section in candidateSections" :key="section.name">
        <h4>{{ section.name }}</h4>
        <input
          v-model="queries[section.kind]"
          :aria-label="'搜索' + section.name"
          placeholder="搜索昵称 / 用户名 / ID"
        /><button
          type="button"
          :disabled="candidateLoading || busy"
          @click="selectSection(section.items)"
        >
          全选 / 取消本栏</button
        ><label v-for="candidate in section.items" :key="candidate.id"
          ><input
            v-model="selected"
            type="checkbox"
            :value="candidate.id"
            :disabled="
              !selected.includes(candidate.id) && selected.length >= capacity
            "
          />{{ candidate.remark || candidate.nickname }}</label
        >
      </section>
      <p>已选 {{ selected.length }} 人 / 还可添加 {{ capacity }} 人</p>
      <button
        v-if="candidateMore"
        type="button"
        @click="
          candidatePage++;
          choices(true);
        "
      >
        加载更多好友</button
      ><template v-if="inviteMode"
        ><label
          ><input
            v-model="allowHistory"
            type="checkbox"
          />允许新成员查看入群前的历史消息</label
        ><button
          class="primary"
          :disabled="!selected.length || busy"
          @click="manage('invite')"
        >
          邀请 {{ selected.length }} 人
        </button></template
      >
    </section>
  </BaseDialog>
</template>

<style scoped>
.group-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px;
  margin-bottom: 15px;
  border: 1px solid var(--panel-line);
  border-radius: 8px;
  background: var(--panel-field);
}
.group-summary .avatar {
  --avatar-size: 44px;
}
.group-summary h3 {
  margin: 0 0 4px;
  font-size: 15px;
  overflow-wrap: anywhere;
}
.group-summary p {
  font-size: 12px;
  color: var(--panel-muted);
}
.group-members-section {
  margin: 11px 0;
}
.group-actions {
  margin-block: 16px;
}
.group-actions > button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.group-profile-fields {
  padding: 11px;
  border: 1px solid var(--ui-line);
  border-radius: 7px;
  background: var(--ui-surface-soft);
}
.vue-group-member > .avatar {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border-radius: 50%;
}
.vue-group-member .vue-group-person > button {
  padding: 0;
  min-height: 24px;
  background: transparent;
  text-align: left;
  overflow-wrap: anywhere;
}
.vue-group-candidates {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--panel-line);
}
.vue-group-candidates > section {
  padding-block: 10px;
  border-bottom: 1px solid var(--panel-line);
}
.vue-preset-icons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.vue-preset-icons button {
  display: grid;
  place-items: center;
  padding: 3px;
}
</style>
