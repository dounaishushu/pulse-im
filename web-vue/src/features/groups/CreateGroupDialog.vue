<script setup lang="ts">
import { computed, inject, onScopeDispose, reactive, shallowRef, useId, useTemplateRef, watch } from "vue";
import type { Conversation, Page, Profile } from "../../api/types";
import { chatKey } from "../../composables/useChat";
import AvatarImage from "../../components/AvatarImage.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import UiIcon from "../../components/UiIcon.vue";
import { filterInvitees, invitationSections } from "./invitationCandidates";

const emit = defineEmits<{ close: [] }>();
const chat = inject(chatKey)!;
const session = chat.client.token;
const formId = useId();
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");
const name = shallowRef("");
const blockFriends = shallowRef(false);
const contacts = shallowRef<Profile[]>([]);
const directory = shallowRef<Conversation[]>([]);
const selected = shallowRef<number[]>([]);
const queries = reactive({ pinned: "", recent: "" });
const loading = shallowRef(true);
const busy = shallowRef(false);
const loadError = shallowRef("");
const saveError = shallowRef("");
const avatarError = shallowRef("");
const avatar = shallowRef<File>();
const avatarPreview = shallowRef("");
const preset = shallowRef(0);
// The create API accepts at most 499 initial members, plus the creator.
const capacity = computed(() => Math.max(0, Math.min(500, chat.config.value?.group_member_limit || 500) - 1));
const people = computed(() => {
  const rows = new Map(contacts.value.map(person => [person.id, person]));
  // Existing private conversations remain available even when they are not
  // contacts. The server still checks each invitee's privacy at creation time.
  for (const row of directory.value) {
    if (row.type !== "direct" || !row.peer_user_id || rows.has(row.peer_user_id)) continue;
    rows.set(row.peer_user_id, {
      id: row.peer_user_id, user_id: row.peer_user_id, nickname: row.name,
      username: "", public_id: "", signature: "", avatar_id: row.avatar_id,
      avatar_url: row.avatar_url || "",
    });
  }
  return [...rows.values()];
});
const ordered = computed(() => invitationSections(people.value, directory.value, chat.me.value?.id));
const sections = computed(() => ordered.value.map(section => ({
  ...section, items: filterInvitees(section.items, queries[section.kind]),
})));
const presets = [
  { name: "护盾", color: "#42c5b5", shape: "M20 8 10 12v8c0 7 10 12 10 12s10-5 10-12v-8Z" },
  { name: "笑脸", color: "#6784f0", shape: "M14 17a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm12 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12 21a8 8 0 0 0 16 0h-3a5 5 0 0 1-10 0Z" },
  { name: "气泡", color: "#a260df", shape: "M8 19a12 12 0 0 1 24 0c0 7-6 12-13 12l-8 4 1-7a12 12 0 0 1-4-9Z" },
  { name: "火箭", color: "#ea77aa", shape: "M16 15c4-6 9-8 15-7 1 6-1 11-7 15l-5-3Zm7-1a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM14 15l-5 1-3 9 8-3Zm10 10-1 7-9 3 3-8Zm-9 0-3-2c-4 2-5 6-5 9 4-1 7-3 8-7Z" },
  { name: "灯泡", color: "#edb557", shape: "M20 7a10 10 0 0 0-7 17c2 2 3 4 3 6h8c0-2 1-4 3-6a10 10 0 0 0-7-17Zm-4 26h8v3h-8Z" },
] as const;
let disposed = false;
let request: AbortController | undefined;
let uploadedAvatar = "";
const current = () => !disposed && !chat.locked.value && chat.client.token === session;
const messageOf = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

async function load() {
  request?.abort();
  const controller = request = new AbortController();
  loading.value = true;
  loadError.value = "";
  try {
    const conversations = await chat.forwardTargets();
    if (!current() || request !== controller) return;
    directory.value = conversations;
    const rows = new Map<number, Profile>();
    for (let page = 1; ; page++) {
      const result = await chat.api<Page<Profile>>(`/contacts?size=100&page=${page}`, {
        deferMedia: true,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      if (!current() || request !== controller) return;
      let added = 0;
      for (const person of result.items) {
        if (!rows.has(person.id)) added++;
        rows.set(person.id, person);
      }
      contacts.value = [...rows.values()];
      const more = result.has_more === true || result.items.length >= 100 &&
        (result.total == null || rows.size < result.total);
      if (!more) break;
      if (!added) throw Error("好友列表分页未推进，请重新加载");
    }
    const available = new Set(people.value.filter(row => row.id !== chat.me.value?.id).map(row => row.id));
    selected.value = selected.value.filter(id => available.has(id)).slice(0, capacity.value);
  } catch (cause) {
    if (current() && request === controller && !controller.signal.aborted) {
      loadError.value = messageOf(cause, "用户列表加载失败，请重试");
      if ([401, 426].includes((cause as { status?: number }).status || 0)) chat.error(cause);
    }
  } finally {
    if (current() && request === controller) loading.value = false;
  }
}
function checked(rows: Profile[]) { return rows.length > 0 && rows.every(row => selected.value.includes(row.id)); }
function indeterminate(rows: Profile[]) { return !checked(rows) && rows.some(row => selected.value.includes(row.id)); }
function toggle(person: Profile) {
  if (busy.value || loading.value || loadError.value) return;
  if (selected.value.includes(person.id)) selected.value = selected.value.filter(id => id !== person.id);
  else if (selected.value.length < capacity.value) selected.value = [...selected.value, person.id];
}
function toggleAll(rows: Profile[]) {
  if (busy.value || loading.value || loadError.value) return;
  const ids = new Set(selected.value);
  if (checked(rows)) rows.forEach(row => ids.delete(row.id));
  else for (const person of rows) {
    if (ids.size >= capacity.value) break;
    ids.add(person.id);
  }
  selected.value = [...ids];
}
function choosePreset(index: number) {
  if (busy.value) return;
  preset.value = index;
  avatar.value = undefined;
  uploadedAvatar = "";
  avatarError.value = "";
  if (fileInput.value) fileInput.value.value = "";
}
function chooseAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value) return;
  if (!file.type.startsWith("image/")) { avatarError.value = "请选择图片文件"; return; }
  if (file.size > 10 * 1024 * 1024) { avatarError.value = "群头像不能超过 10 MB"; return; }
  avatarError.value = "";
  avatar.value = file;
}
watch(avatar, file => {
  uploadedAvatar = "";
  if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value);
  avatarPreview.value = file ? URL.createObjectURL(file) : "";
});
async function presetFile() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 160;
  const context = canvas.getContext("2d");
  if (!context) throw Error("群头像生成失败，请选择自定义图片");
  context.scale(4, 4);
  context.fillStyle = presets[preset.value]!.color;
  context.fillRect(0, 0, 40, 40);
  context.fillStyle = "#fff";
  context.fill(new Path2D(presets[preset.value]!.shape), "evenodd");
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw Error("群头像生成失败，请重试");
  return new File([blob], "group-avatar.png", { type: "image/png" });
}
async function create() {
  if (busy.value || loading.value || loadError.value || !current()) return;
  if (!name.value.trim()) { saveError.value = "请填写群名称"; return; }
  if (selected.value.length > capacity.value) { saveError.value = "已选人数超过群组容量，请减少后重试"; return; }
  busy.value = true;
  saveError.value = "";
  try {
    if (!uploadedAvatar) {
      const file = avatar.value || await presetFile();
      uploadedAvatar = (await chat.client.uploadMedia("avatar", file, { signal: AbortSignal.timeout(60000) })).url;
    }
    if (!current()) return;
    const row = await chat.post<Conversation>("/conversations/groups", {
      name: name.value.trim(), member_ids: [...selected.value],
      allow_member_add_friend: !blockFriends.value, avatar_url: uploadedAvatar,
    });
    if (!current()) return;
    // Close once creation succeeds, so a subsequent directory refresh failure
    // cannot encourage a duplicate group creation.
    emit("close");
    await chat.loadDirectory();
    if (!chat.locked.value && chat.client.token === session) await chat.choose(row.id);
  } catch (cause) {
    if (current()) {
      saveError.value = messageOf(cause, "群聊创建失败，请重试");
      if ([401, 426].includes((cause as { status?: number }).status || 0)) chat.error(cause);
    }
  } finally { if (current()) busy.value = false; }
}
watch(chat.locked, locked => { if (locked) emit("close"); });
watch(() => chat.client.token, token => { if (token !== session) emit("close"); });
onScopeDispose(() => {
  disposed = true;
  request?.abort();
  if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value);
});
void load();
</script>

<template>
  <BaseDialog title="创建群聊" layout="group-create" :busy="busy" @close="emit('close')">
    <form :id="formId" class="create-group" @submit.prevent="create">
      <div class="create-identity">
        <label class="create-name"><span>群名称</span><input v-model="name" aria-label="群名称" placeholder="请输入群名称"
          required maxlength="128" autocomplete="off" data-dialog-autofocus :disabled="busy" /></label>
        <div class="create-avatars" role="group" aria-label="群头像">
          <span class="create-avatar-label">群头像</span>
          <div class="create-avatar-options">
            <button v-for="(item, index) in presets" :key="item.name" type="button" class="create-preset"
              :style="{ '--preset-color': item.color }" :aria-label="item.name + '群头像'" :aria-pressed="!avatar && preset === index"
              :disabled="busy" @click="choosePreset(index)">
              <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" :fill="item.color" /><path :d="item.shape" fill="#fff" fill-rule="evenodd" /></svg>
            </button>
            <button v-if="avatarPreview" type="button" class="create-custom-avatar" aria-label="更换自定义群头像" aria-pressed="true"
              :disabled="busy" @click="fileInput?.click()"><img :src="avatarPreview" alt="自定义群头像预览" /></button>
            <button type="button" class="create-upload" aria-label="上传群头像" title="上传自定义群头像，最大 10 MB"
              :disabled="busy" @click="fileInput?.click()"><UiIcon name="plus" /></button>
            <input v-show="false" ref="fileInput" class="create-file-input" type="file" accept="image/*" aria-label="选择群头像文件" :disabled="busy" @change="chooseAvatar" />
          </div>
        </div>
        <p v-if="avatarError" class="create-error" role="alert">{{ avatarError }}</p>
      </div>
      <div v-if="loadError || saveError" class="create-error" role="alert">
        <span>{{ loadError || saveError }}</span><button v-if="loadError && !busy" type="button" class="ui-text-button" @click="load">重新加载</button>
      </div>
      <div class="create-columns" :aria-busy="loading">
        <section v-for="section in sections" :key="section.kind" class="create-column" :aria-label="section.name">
          <h3>{{ section.name }}</h3>
          <div class="create-search-row">
            <input v-model="queries[section.kind]" class="create-search" :aria-label="'搜索' + section.name" placeholder="搜索昵称/用户名/ID" autocomplete="off" :disabled="busy" />
            <label class="create-select-all"><input type="checkbox" :aria-label="'全选' + section.name"
              :checked="checked(section.items)" :indeterminate="indeterminate(section.items)"
              :disabled="busy || loading || !!loadError || !section.items.length || (!checked(section.items) && selected.length >= capacity)"
              @change="toggleAll(section.items)" />全选</label>
          </div>
          <div class="create-people">
            <label v-for="person in section.items" :key="person.id" class="create-person" :class="{ chosen: selected.includes(person.id) }">
              <input type="checkbox" :checked="selected.includes(person.id)" :aria-label="'选择 ' + (person.remark || person.nickname)"
                :disabled="busy || loading || !!loadError || (!selected.includes(person.id) && selected.length >= capacity)" @change="toggle(person)" />
              <AvatarImage :name="person.remark || person.nickname" :src="person.avatar_url" :media-id="person.avatar_id" />
              <span class="create-person-info"><strong>{{ person.remark || person.nickname }}</strong><small>{{ person.username ? '@' + person.username : person.public_id || '私聊用户' }}</small></span>
            </label>
            <p v-if="loading" class="create-empty" role="status">正在加载用户…</p>
            <p v-else-if="!section.items.length" class="create-empty">{{ queries[section.kind].trim() ? '没有找到匹配的用户' : section.kind === 'pinned' ? '暂无置顶用户' : '暂无可选择的用户' }}</p>
          </div>
        </section>
      </div>
    </form>
    <template #footer>
      <div class="create-footer">
        <label class="create-privacy"><input v-model="blockFriends" type="checkbox" :disabled="busy" />禁止群成员互加好友</label>
        <span class="create-count" aria-live="polite" :title="`最多可选择 ${capacity} 人`">已选 {{ selected.length }} 人</span>
        <button type="button" class="create-cancel" :disabled="busy" @click="emit('close')">取消</button>
        <button type="submit" :form="formId" class="primary create-submit" :disabled="busy || loading || !!loadError || !name.trim()">{{ busy ? '创建中…' : '创建' }}</button>
      </div>
    </template>
  </BaseDialog>
</template>

<style scoped>
.create-group { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.create-identity { flex: none; padding: 0 18px 14px; }
.create-group .create-identity .create-name { display: flex; align-items: center; gap: 12px; margin: 0 0 18px; font-size: 13px; }
.create-name > span, .create-avatar-label { width: 48px; flex: none; text-align: right; font-size: 13px; }
.create-group .create-identity .create-name > input { max-width: 464px; min-height: 34px; border: 1px solid transparent; background: var(--ui-fill); border-radius: 4px; font-size: 12px; }
.create-group .create-identity .create-name > input:focus, .create-group .create-search-row .create-search:focus { border-color: var(--ui-focus); background: var(--ui-surface); }
.create-avatars, .create-avatar-options { display: flex; align-items: center; gap: 12px; }
.create-avatar-options { gap: 11px; flex-wrap: wrap; }
.create-avatar-options > button { display: grid; place-items: center; flex: none; width: 36px; height: 36px; min-height: 0; padding: 3px; border-radius: 50%; }
.create-avatar-options .create-preset { border: 1px solid var(--preset-color); background: var(--ui-surface); }
.create-preset svg { display: block; width: 28px; height: 28px; }
.create-avatar-options > button[aria-pressed="true"] { outline: 2px solid var(--ui-primary); outline-offset: 3px; }
.create-avatar-options .create-upload { border: 1px solid var(--ui-line); background: var(--ui-fill); color: var(--ui-muted); font-size: 20px; }
.create-avatar-options .create-custom-avatar { padding: 0; border: 1px solid var(--ui-line); }
.create-custom-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
.create-group .create-avatar-options .create-file-input { display: none; }
.create-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); flex: 1; min-height: 0; }
.create-column { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 0 20px; }
.create-column + .create-column { border-inline-start: 1px solid var(--ui-line); }
.create-group .create-column h3 { margin: 0; padding: 0 10px 12px; border-bottom: 1px solid var(--ui-line); font-size: 13px; font-weight: 500; }
.create-search-row { display: flex; align-items: center; gap: 9px; padding: 15px 10px 9px; border-bottom: 1px solid var(--ui-line); }
.create-group .create-search-row .create-search { min-height: 28px; padding: 5px 8px; border: 1px solid transparent; border-radius: 3px; background: var(--ui-fill); font-size: 12px; }
.create-group .create-search-row .create-select-all { display: flex; flex-wrap: nowrap; flex: none; align-items: center; gap: 4px; margin: 0; color: var(--ui-muted); font-size: 12px; white-space: nowrap; }
.create-people { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 3px 10px 0; }
.create-group .create-column .create-person { display: flex; flex-wrap: nowrap; align-items: center; gap: 10px; min-height: 48px; margin: 0; padding: 7px 0; border-radius: 4px; cursor: pointer; --avatar-size: 32px; --avatar-radius: 50%; }
.create-person:hover, .create-person.chosen { background: var(--ui-fill); }
.create-person-info { display: grid; min-width: 0; gap: 4px; }
.create-person-info strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 16px; font-weight: 500; }
.create-person-info small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-muted); font-size: 11px; line-height: 13px; }
.create-group .create-person > input[type="checkbox"], .create-group .create-select-all > input[type="checkbox"], .create-footer .create-privacy > input[type="checkbox"] { width: 15px; height: 15px; flex: none; }
.create-empty { margin: 26px 0; text-align: center; color: var(--ui-muted); font-size: 12px; }
.create-error { display: flex; align-items: center; gap: 6px; flex: none; margin: 0 20px 10px; color: var(--ui-danger, #c43e45); font-size: 12px; }
.create-footer { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; }
.create-footer .create-privacy { display: flex; align-items: center; gap: 5px; margin: 0 auto 0 0; color: var(--ui-muted); font-size: 12px; }
.create-count { color: var(--ui-muted); font-size: 12px; white-space: nowrap; }
.create-footer > button { min-width: 58px; min-height: 30px; padding: 6px 14px; font-size: 12px; }
.create-footer .create-cancel { border: 1px solid var(--ui-line); background: var(--ui-surface); color: var(--ui-muted); }
@media (max-width: 740px) {
  .create-column { padding-inline: 10px; }
  .create-search-row, .create-people { padding-inline: 3px; }
  .create-identity { padding-inline: 10px; }
}
@media (max-width: 540px) {
  .create-footer { flex-wrap: wrap; justify-content: flex-end; }
  .create-footer .create-privacy { width: 100%; }
  .create-count { margin-inline-end: auto; }
  .create-avatars, .create-avatar-options { gap: 8px; }
}
</style>
