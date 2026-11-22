<script setup lang="ts">
import { computed, inject, onScopeDispose, reactive, shallowRef, watch } from "vue";
import type { Conversation, Group, Page, Profile } from "../../api/types";
import { chatKey } from "../../composables/useChat";
import AvatarImage from "../../components/AvatarImage.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { filterInvitees, invitationSections } from "./invitationCandidates";

const props = defineProps<{ conversation: Conversation }>();
const emit = defineEmits<{ close: []; updated: [] }>();
const chat = inject(chatKey)!;
const sourceId = props.conversation.id;
const session = chat.client.token;
const group = shallowRef<Group | null>(null);
const directory = shallowRef<Conversation[]>([]);
const candidates = shallowRef<Profile[]>([]);
const selected = shallowRef<number[]>([]);
const allowHistory = shallowRef(false);
const loading = shallowRef(true);
const loadingMore = shallowRef(false);
const busy = shallowRef(false);
const error = shallowRef("");
const failures = shallowRef<Record<number, string>>({});
const queries = reactive({ pinned: "", recent: "" });
const capacity = computed(() => Math.max(0, (group.value?.member_limit ?? 500) - (group.value?.member_count ?? 0)));
const canManage = computed(() => ["owner", "admin"].includes(chat.active.value?.my_role ?? group.value?.my_role ?? ""));
const canInvite = computed(() => group.value?.can_invite === true &&
  (canManage.value || chat.active.value?.allow_member_invites === true));
const orderedSections = computed(() => invitationSections(candidates.value, directory.value, chat.me.value?.id));
const sections = computed(() => orderedSections.value.map(section => ({
  ...section, items: filterInvitees(section.items, queries[section.kind]),
})));
let disposed = false;
let request: AbortController | undefined;
const current = () => !disposed && !chat.locked.value && chat.client.token === session && chat.active.value?.id === sourceId;
const options = (controller: AbortController) => ({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), deferMedia: true });
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : "邀请列表加载失败，请重试";

async function load() {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  loadingMore.value = false;
  error.value = "";
  try {
    const profile = await chat.api<Group>(`/conversations/groups/profile?conversation_id=${sourceId}`, options(controller));
    if (!current() || request !== controller) return;
    group.value = profile;
    if (!profile.can_invite) {
      error.value = "当前账号没有邀请入群权限";
      return;
    }
    // The API applies membership and privacy filters. Do not add directory users
    // to this list: doing so would bypass those filters.
    const people = new Map<number, Profile>();
    let legacyDirectoryLoaded = false;
    for (let page = 1; ; page++) {
      const result = await chat.api<Page<Profile>>(
        `/conversations/invite-candidates?conversation_id=${sourceId}&page=${page}&size=100`, options(controller));
      if (!current() || request !== controller) return;
      if (!legacyDirectoryLoaded && result.items.some(person => typeof person.is_pinned !== "boolean")) {
        const conversations = await chat.forwardTargets();
        if (!current() || request !== controller) return;
        directory.value = conversations;
        legacyDirectoryLoaded = true;
      }
      let added = 0;
      for (const person of result.items) {
        if (!people.has(person.id)) added++;
        people.set(person.id, person);
      }
      candidates.value = [...people.values()];
      loading.value = false;
      loadingMore.value = result.has_more === true;
      if (!result.has_more) break;
      if (!added) throw Error("邀请列表分页未推进，请重新加载");
    }
    selected.value = selected.value.filter(id => people.has(id)).slice(0, capacity.value);
  } catch (cause) {
    if (current() && request === controller && !controller.signal.aborted) error.value = messageOf(cause);
  } finally {
    if (request === controller && current()) { loading.value = false; loadingMore.value = false; }
  }
}
function checked(rows: Profile[]) { return rows.length > 0 && rows.every(row => selected.value.includes(row.id)); }
function indeterminate(rows: Profile[]) { return !checked(rows) && rows.some(row => selected.value.includes(row.id)); }
function toggle(person: Profile) {
  if (busy.value || loading.value || !canInvite.value) return;
  if (selected.value.includes(person.id)) selected.value = selected.value.filter(id => id !== person.id);
  else if (selected.value.length < capacity.value) selected.value = [...selected.value, person.id];
}
function toggleAll(rows: Profile[]) {
  if (busy.value || loading.value || loadingMore.value || !canInvite.value) return;
  const ids = new Set(selected.value);
  if (checked(rows)) rows.forEach(row => ids.delete(row.id));
  else for (const row of rows) {
    if (ids.size >= capacity.value) break;
    ids.add(row.id);
  }
  selected.value = [...ids];
}
async function invite() {
  if (busy.value || loading.value || !current() || !canInvite.value || !selected.value.length) return;
  if (selected.value.length > capacity.value) { error.value = "已选人数超过群组剩余容量，请减少后重试"; return; }
  busy.value = true;
  // Stop candidate pagination before writes so a late page cannot restore
  // users who have just joined or replace a rejected user's selection.
  request?.abort();
  request = undefined;
  loadingMore.value = false;
  error.value = "";
  failures.value = {};
  const ids = [...selected.value];
  const joined = new Set<number>();
  const rejected: Record<number, string> = {};
  try {
    for (let start = 0; start < ids.length; start += 50) {
      const batch = ids.slice(start, start + 50);
      const result = await chat.post<{
        items: { user_id: number; status: string; message?: string }[];
        member_count?: number;
        remaining?: number;
      }>("/conversations/members/batch", {
        conversation_id: sourceId, user_ids: batch, allow_history: canManage.value && allowHistory.value,
      });
      if (!current()) return;
      for (const id of batch) {
        const item = result.items.find(row => row.user_id === id);
        if (item?.status === "joined") joined.add(id);
        else rejected[id] = item?.message || "邀请未完成，请重新加载后重试";
      }
      selected.value = selected.value.filter(id => !joined.has(id));
      candidates.value = candidates.value.filter(row => !joined.has(row.id));
      if (group.value && result.member_count != null) group.value = { ...group.value, member_count: result.member_count };
    }
    failures.value = rejected;
    if (Object.keys(rejected).length) error.value = `${joined.size} 人已加入；其余用户未加入，请查看提示`;
    else emit("close");
  } catch (cause) {
    if (current()) {
      failures.value = rejected;
      error.value = `${joined.size ? `已有 ${joined.size} 人加入。` : ""}${messageOf(cause)}`;
    }
  } finally {
    if (joined.size) { emit("updated"); void chat.loadDirectory(); }
    if (current()) busy.value = false;
  }
}
watch(() => chat.active.value?.id, id => { if (id !== sourceId) emit("close"); });
watch(chat.locked, locked => { if (locked) emit("close"); });
watch(() => [chat.active.value?.my_role, chat.active.value?.allow_member_invites], () => {
  if (!canManage.value) {
    allowHistory.value = false;
    if (chat.active.value?.allow_member_invites !== true) emit("close");
  }
});
onScopeDispose(() => { disposed = true; request?.abort(); });
void load();
</script>

<template>
  <BaseDialog title="邀请新成员" layout="invitation" :busy="busy" @close="emit('close')">
    <div class="invite-group-summary">
      <AvatarImage :name="group?.name || conversation.name" :src="group?.avatar_url || conversation.avatar_url" :media-id="group?.avatar_id || conversation.avatar_id" />
      <div><strong>{{ group?.name || conversation.name }}</strong><p>{{ group?.member_count ?? conversation.member_count ?? '—' }} 名成员</p></div>
    </div>
    <div v-if="error" class="invite-error" role="alert">
      <span>{{ error }}</span>
      <button v-if="!busy" type="button" class="ui-text-button" @click="load">重新加载</button>
    </div>
    <p v-if="loading" class="invite-loading" role="status">正在加载可邀请用户…</p>
    <p v-else-if="loadingMore" class="invite-loading" role="status">正在加载更多可邀请用户，可先选择并邀请…</p>
    <div class="invite-columns" :aria-busy="loading || loadingMore">
      <section v-for="section in sections" :key="section.kind" class="invite-column" :aria-label="section.name">
        <h3>{{ section.name }}</h3>
        <div class="invite-search-row">
          <input v-model="queries[section.kind]" class="invite-search" :aria-label="`搜索${section.name}`"
            placeholder="搜索昵称/用户名/ID" :disabled="busy" autocomplete="off" />
          <label class="invite-select-all"><input type="checkbox" :aria-label="`全选${section.name}`"
            :checked="checked(section.items)" :indeterminate="indeterminate(section.items)"
            :disabled="busy || loading || loadingMore || !canInvite || !section.items.length || (!checked(section.items) && selected.length >= capacity)"
            @change="toggleAll(section.items)" />全选</label>
        </div>
        <div class="invite-people">
          <label v-for="person in section.items" :key="person.id" class="invite-person" :class="{ chosen: selected.includes(person.id) }">
            <input type="checkbox" :checked="selected.includes(person.id)" :aria-label="`邀请 ${person.remark || person.nickname}`"
              :disabled="busy || loading || !canInvite || (!selected.includes(person.id) && selected.length >= capacity)" @change="toggle(person)" />
            <AvatarImage :name="person.remark || person.nickname" :src="person.avatar_url" :media-id="person.avatar_id" />
            <span class="invite-person-info"><strong>{{ person.remark || person.nickname }}</strong><small>{{ person.username ? '@' + person.username : person.public_id }}</small>
              <span v-if="failures[person.id]" class="invite-person-error">{{ failures[person.id] }}</span>
            </span>
          </label>
          <p v-if="!section.items.length && !loading" class="invite-empty">{{ queries[section.kind].trim() ? '没有匹配的用户' : section.kind === 'pinned' ? '暂无置顶用户' : '暂无可选择的用户' }}</p>
        </div>
      </section>
    </div>
    <template #footer>
      <span class="invite-privacy">邀请将遵循对方的隐私设置</span>
      <span class="invite-count">已选 {{ selected.length }} 人</span>
      <button type="button" :disabled="busy" @click="emit('close')">取消</button>
      <button type="button" class="primary" :disabled="busy || loading || !canInvite || !selected.length" @click="invite">{{ busy ? '邀请中…' : '邀请' }}</button>
      <label v-if="canManage" class="invite-history"><input v-model="allowHistory" type="checkbox" :disabled="busy" />允许新成员查看入群前的历史消息</label>
    </template>
  </BaseDialog>
</template>

<style scoped>
.invite-group-summary { display: flex; align-items: center; gap: 12px; padding: 0 6px 22px; --avatar-size: 48px; --avatar-radius: 50%; }
.invite-group-summary strong { font-size: 14px; font-weight: 500; }
.invite-group-summary p { margin: 5px 0 0; font-size: 12px; color: var(--ui-muted); }
.invite-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); flex: 1; min-height: 0; }
.invite-column { display: flex; flex-direction: column; min-height: 0; min-width: 0; padding: 0 20px; }
.invite-column + .invite-column { border-inline-start: 1px solid var(--ui-line); }
.invite-column h3 { font-size: 14px; font-weight: 500; padding-bottom: 12px; border-bottom: 1px solid var(--ui-line); }
.invite-search-row { display: flex; align-items: center; gap: 8px; padding: 14px 0 10px; border-bottom: 1px solid var(--ui-line); }
.invite-search { width: 100%; min-width: 0; padding: 7px 9px; font-size: 12px; background: var(--ui-fill); border: 1px solid transparent; border-radius: 4px; }
.invite-search:focus { background: var(--ui-surface); border-color: var(--ui-focus); }
.invite-select-all { display: flex; align-items: center; gap: 3px; flex: none; color: var(--ui-muted); font-size: 12px; white-space: nowrap; }
.invite-people { flex: 1; min-height: 0; overflow: auto; scrollbar-width: thin; overscroll-behavior: contain; padding-top: 6px; }
.invite-person { display: flex; align-items: center; gap: 9px; padding: 8px 5px; border-radius: 4px; cursor: pointer; --avatar-size: 32px; --avatar-radius: 50%; }
.invite-person:hover, .invite-person.chosen { background: var(--ui-fill); }
.invite-person-info { display: grid; min-width: 0; gap: 3px; }
.invite-person-info strong { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.invite-person-info small { color: var(--ui-muted); font-size: 11px; }
.invite-empty { margin-top: 27px; text-align: center; font-size: 12px; color: var(--ui-muted); }
.invite-error { display: flex; gap: 8px; align-items: center; padding: 7px 6px; font-size: 12px; color: var(--ui-danger, #c43e45); }
.invite-person-error { font-size: 12px; color: var(--ui-danger, #c43e45); }
.invite-loading { padding: 0 6px 8px; font-size: 12px; color: var(--ui-muted); }
.invite-privacy { margin-inline-end: auto; color: var(--ui-muted); font-size: 11px; }
.invite-count { color: var(--ui-muted); font-size: 12px; }
.invite-history { display: flex; align-items: center; gap: 5px; max-width: 190px; font-size: 11px; color: var(--ui-muted); }
.invite-history input, .invite-select-all input, .invite-person > input { flex: none; width: 15px; height: 15px; accent-color: var(--ui-accent, #389acb); }
@media (max-width: 620px) {
  .invite-column { padding-inline: 8px; }
  .invite-privacy { width: 100%; }
  .invite-history { max-width: none; }
}
</style>
