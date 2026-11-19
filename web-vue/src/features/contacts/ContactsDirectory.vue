<script lang="ts">
import type { Profile } from "../../api/types";

export type ContactSection = "friends" | "search" | "requests" | "blocked";
export type ContactEntry = Pick<Profile, "id" | "nickname" | "remark"> &
  Partial<Pick<Profile, "username" | "public_id" | "avatar_url">>;
</script>

<script setup lang="ts">
import { computed, useTemplateRef } from "vue";
import type { FriendRequest } from "../../api/types";
import UiIcon from "../../components/UiIcon.vue";
import ContactIdentity from "./ContactIdentity.vue";

const props = defineProps<{
  section: ContactSection;
  keyword: string;
  contacts: ContactEntry[];
  requests: FriendRequest[];
  loading: boolean;
  working: boolean;
  failed: boolean;
  searched: boolean;
  notice: string;
  hasMore: boolean;
}>();
const emit = defineEmits<{
  select: [section: ContactSection];
  "update:keyword": [value: string];
  search: [];
  retry: [];
  more: [];
  profile: [id: number];
  action: [
    action: "chat" | "request" | "unblock" | "accept" | "reject",
    id: number,
  ];
  clearRequests: [];
}>();
const tabs = [
  { id: "friends", label: "我的好友", icon: "profile" },
  { id: "search", label: "添加好友", icon: "userAdd" },
  { id: "requests", label: "好友验证", icon: "check" },
  { id: "blocked", label: "黑名单", icon: "shield" },
] as const;
const searchField = useTemplateRef<HTMLInputElement>("searchField");
const active = computed(() => tabs.find((tab) => tab.id === props.section)!);
const placeholder = computed(
  () =>
    ({
      friends: "搜索好友",
      search: "输入用户名或手机号",
      blocked: "搜索黑名单",
      requests: "",
    })[props.section],
);
const hasRows = computed(() =>
  props.section === "requests"
    ? props.requests.length > 0
    : props.contacts.length > 0,
);
const emptyText = computed(() => {
  if (props.section === "search")
    return props.searched ? "没有找到这个用户" : "搜索要添加的账号";
  if (props.section === "requests") return "暂无待处理的好友验证";
  if (props.keyword.trim()) return "没有匹配的联系人";
  return props.section === "blocked" ? "黑名单为空" : "暂无好友";
});
function accountLabel(row: ContactEntry) {
  const account = row.username || row.public_id;
  return account === (row.remark || row.nickname) ? undefined : account;
}
function clearSearch() {
  emit("update:keyword", "");
  searchField.value?.focus();
}
</script>

<template>
  <div class="contacts-directory">
    <nav class="contacts-navigation" aria-label="联系人分类">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        :aria-current="section === tab.id ? 'page' : undefined"
        :disabled="working"
        @click="emit('select', tab.id)"
      >
        <UiIcon :name="tab.icon" />
        <span>{{ tab.label }}</span>
      </button>
    </nav>

    <section class="contacts-content" :aria-label="active.label">
      <header v-if="section === 'requests'" class="contacts-toolbar">
        <span class="contacts-pending">
          待处理<span v-if="!loading && !failed">{{ requests.length }}</span>
        </span>
        <button
          type="button"
          class="ui-icon-button contacts-refresh"
          aria-label="刷新好友验证"
          title="刷新好友验证"
          :disabled="working || loading"
          @click="emit('retry')"
        >
          <UiIcon name="refresh" />
        </button>
        <button
          type="button"
          class="contact-action neutral"
          :disabled="working || loading || !requests.length"
          @click="emit('clearRequests')"
        >
          清除通知
        </button>
      </header>

      <form
        v-else
        class="contacts-toolbar"
        @submit.prevent="section === 'search' && emit('search')"
      >
        <div class="contacts-search">
          <UiIcon name="search" />
          <input
            ref="searchField"
            :key="section"
            type="text"
            :value="keyword"
            :aria-label="placeholder"
            :placeholder="placeholder"
            :disabled="working"
            enterkeyhint="search"
            autocomplete="off"
            spellcheck="false"
            @input="
              emit('update:keyword', ($event.target as HTMLInputElement).value)
            "
          />
          <button
            v-if="keyword"
            type="button"
            class="ui-icon-button contacts-clear"
            aria-label="清空搜索"
            :disabled="working"
            @click="clearSearch"
          >
            <UiIcon name="close" />
          </button>
        </div>
        <button
          v-if="section === 'search'"
          type="submit"
          class="contact-action primary"
          :disabled="working || loading || !keyword.trim()"
        >
          搜索
        </button>
      </form>

      <div :key="section" class="contacts-scroll" :aria-busy="loading">
        <p v-if="notice" class="contacts-notice" role="status">{{ notice }}</p>
        <div v-if="loading && !hasRows" class="contacts-state" role="status">
          加载中…
        </div>
        <template v-else-if="hasRows">
          <ul v-if="section === 'requests'" class="contacts-list">
            <li
              v-for="row in requests"
              :key="row.id"
              class="contact-row request-row"
            >
              <ContactIdentity
                :name="row.nickname"
                :subtitle="row.message"
                wrap-subtitle
              />
              <div class="contact-actions">
                <button
                  type="button"
                  class="contact-action neutral"
                  :disabled="working || loading"
                  @click="emit('action', 'reject', row.id)"
                >
                  拒绝
                </button>
                <button
                  type="button"
                  class="contact-action accent"
                  :disabled="working || loading"
                  @click="emit('action', 'accept', row.id)"
                >
                  同意
                </button>
              </div>
            </li>
          </ul>
          <ul v-else class="contacts-list">
            <li v-for="row in contacts" :key="row.id" class="contact-row">
              <button
                type="button"
                class="contact-main"
                :aria-label="
                  section === 'friends'
                    ? `向 ${row.remark || row.nickname} 发消息`
                    : `查看 ${row.remark || row.nickname} 的资料`
                "
                :disabled="working"
                @click="
                  section === 'friends'
                    ? emit('action', 'chat', row.id)
                    : emit('profile', row.id)
                "
              >
                <ContactIdentity
                  :name="row.remark || row.nickname"
                  :avatar="row.avatar_url"
                  :subtitle="accountLabel(row)"
                />
              </button>
              <button
                v-if="section === 'friends'"
                type="button"
                class="ui-icon-button contacts-profile"
                :aria-label="`查看 ${row.remark || row.nickname} 的资料`"
                title="查看资料"
                :disabled="working"
                @click="emit('profile', row.id)"
              >
                <UiIcon name="info" />
              </button>
              <button
                v-else-if="section === 'search'"
                type="button"
                class="contact-action accent"
                :disabled="working"
                @click="emit('action', 'request', row.id)"
              >
                加好友
              </button>
              <button
                v-else
                type="button"
                class="contact-action neutral"
                :disabled="working"
                @click="emit('action', 'unblock', row.id)"
              >
                解除拉黑
              </button>
            </li>
          </ul>
        </template>
        <div v-else-if="!failed" class="contacts-state" role="status">
          <UiIcon :name="active.icon" />
          <span>{{ emptyText }}</span>
        </div>
        <button
          v-if="hasMore && !failed"
          type="button"
          class="ui-text-button contacts-more"
          :disabled="working || loading"
          @click="emit('more')"
        >
          {{ loading ? "加载中…" : "加载更多" }}
        </button>
        <div v-if="failed" class="contacts-state" role="status">
          <span>加载失败</span>
          <button type="button" class="ui-text-button" @click="emit('retry')">
            重试
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.contacts-directory {
  --directory-gutter: 16px;
  display: grid;
  grid-template-columns: 156px minmax(0, 1fr);
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.contacts-navigation {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-inline-end: 1px solid var(--ui-line);
  background: var(--ui-surface-soft);
}
.contacts-navigation button {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 0 10px;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-muted);
  font-size: 14px;
  text-align: start;
  white-space: nowrap;
}
.contacts-navigation .ui-icon {
  flex: none;
  font-size: 18px;
}
.contacts-navigation button:not(:disabled):hover {
  color: var(--ui-text);
}
.contacts-navigation button[aria-current],
.contacts-navigation button[aria-current]:hover {
  background: var(--art-active-color);
  color: var(--ui-primary);
  font-weight: 600;
}
.contacts-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.contacts-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 12px var(--directory-gutter);
  border-bottom: 1px solid var(--ui-line);
}
.contacts-search {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 8px;
  min-width: 0;
  min-height: 40px;
  padding-inline: 10px 4px;
  border: 1px solid var(--ui-line);
  border-radius: 7px;
  background: var(--ui-surface-soft);
  color: var(--ui-muted);
}
.contacts-search:focus-within {
  border-color: var(--ui-focus);
  background: var(--ui-surface);
}
.contacts-search > .ui-icon {
  flex: none;
  font-size: 17px;
}
.contacts-directory .contacts-search input {
  flex: 1;
  min-width: 0;
  min-height: 38px;
  padding: 0;
  border: 0;
  background: transparent;
  outline: none;
  font-size: 13px;
}
.contacts-clear {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  font-size: 15px;
}
.contacts-pending {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 1;
  font-weight: 600;
  font-size: 14px;
}
.contacts-pending > span {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.contacts-refresh {
  font-size: 16px;
}
.contacts-scroll {
  flex: 1;
  min-height: 0;
  padding: 4px 8px 12px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.contacts-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.contact-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 60px;
  padding: 0 8px;
  border-radius: 6px;
}
.contact-row + .contact-row::before {
  position: absolute;
  inset: 0 8px auto 60px;
  height: 1px;
  background: var(--ui-line);
  pointer-events: none;
  content: "";
}
.contact-row:hover,
.contact-row:focus-within {
  background: var(--art-hover-color);
}
.request-row {
  padding-block: 8px;
}
.contacts-notice {
  padding: 8px;
  color: var(--ui-success);
  font-size: 13px;
}
.contact-main {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  min-height: 59px;
  padding: 0;
  background: transparent;
}
.contact-main:not(:disabled):hover {
  background: transparent;
}
.contacts-profile {
  width: 40px;
  height: 40px;
  font-size: 17px;
}
.contacts-directory .ui-icon-button:not(:disabled):hover {
  background: var(--ui-fill);
  color: var(--ui-primary);
}
.contact-actions {
  display: flex;
  gap: 4px;
  flex: none;
}
.contact-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-height: 36px;
  padding: 0 10px;
  font-size: 13px;
  white-space: nowrap;
}
.contact-action.primary {
  min-height: 40px;
  padding-inline: 16px;
}
.contact-action.neutral {
  background: transparent;
  color: var(--ui-muted);
}
.contact-action.neutral:not(:disabled):hover {
  background: var(--ui-fill);
  color: var(--ui-text);
}
.contact-action.accent {
  background: var(--art-active-color);
  color: var(--ui-primary);
  font-weight: 600;
}
.contact-action.accent:not(:disabled):hover {
  background: color-mix(
    in srgb,
    var(--art-active-color),
    var(--ui-primary) 12%
  );
}
.contacts-more {
  display: flex;
  width: fit-content;
  margin: 12px auto 0;
  font-size: 13px;
}
.contacts-state {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 12px;
  min-height: 176px;
  padding: 20px 12px;
  color: var(--ui-muted);
  font-size: 13px;
  text-align: center;
}
.contacts-state .ui-icon {
  font-size: 28px;
}
@media (max-width: 620px) {
  .contacts-directory {
    --directory-gutter: 12px;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .contacts-navigation {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    padding: 8px;
    border-inline-end: 0;
    border-bottom: 1px solid var(--ui-line);
  }
  .contacts-navigation button {
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    min-height: 52px;
    padding: 4px 0;
    font-size: 12px;
  }
  .contacts-scroll {
    padding-inline: 4px;
  }
  .contacts-profile,
  .contacts-refresh {
    width: 44px;
    height: 44px;
  }
  .contact-action {
    min-height: 44px;
  }
}
</style>
