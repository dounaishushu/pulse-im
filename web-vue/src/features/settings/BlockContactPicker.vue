<script setup lang="ts">
import { computed, onMounted, shallowRef, useTemplateRef } from "vue";
import ContactIdentity from "../contacts/ContactIdentity.vue";
import UiIcon from "../../components/UiIcon.vue";
import type { Profile } from "../../api/types";

const props = defineProps<{
  contacts: readonly Profile[];
  busy: boolean;
  hasMore: boolean;
  loading: boolean;
  loadError: string;
}>();
const emit = defineEmits<{ block: [id: number]; cancel: []; loadMore: [] }>();
const search = useTemplateRef<HTMLInputElement>("search");
const query = shallowRef("");
const matches = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return props.contacts;
  return props.contacts.filter((person) =>
    [person.remark, person.nickname, person.username, person.public_id].some(
      (value) => value?.toLowerCase().includes(keyword),
    ),
  );
});
onMounted(() => search.value?.focus({ preventScroll: true }));
</script>

<template>
  <section aria-label="选择要屏蔽的联系人" class="block-contact-picker">
    <div class="block-contact-toolbar">
      <input
        ref="search"
        v-model="query"
        type="search"
        aria-label="搜索联系人"
        placeholder="搜索联系人"
        :disabled="busy"
      />
      <button type="button" :disabled="busy" @click="emit('cancel')">
        取消
      </button>
    </div>
    <p v-if="!matches.length" class="block-contact-empty" role="status">
      {{
        hasMore
          ? "可继续加载更多联系人"
          : query.trim() ? "没有匹配的联系人" : "暂无可屏蔽的联系人"
      }}
    </p>
    <button
      v-for="person in matches"
      :key="person.id"
      type="button"
      class="block-contact-option"
      :disabled="busy"
      @click="emit('block', person.id)"
    >
      <ContactIdentity
        :name="person.remark || person.nickname || person.username || person.public_id"
        :avatar="person.avatar_url"
        :subtitle="person.username"
      />
      <span class="block-contact-action"><UiIcon name="shield" /> 屏蔽</span>
    </button>
    <p v-if="loadError" class="block-contact-empty" role="alert">{{ loadError }}</p>
    <div v-if="hasMore">
      <button type="button" :disabled="busy || loading" @click="emit('loadMore')">
        {{ loading ? "正在加载…" : "加载更多联系人" }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.block-contact-picker {
  display: grid;
  gap: 6px;
}
.block-contact-toolbar,
button.block-contact-option {
  display: flex;
  align-items: center;
  gap: 10px;
}
.block-contact-toolbar input {
  flex: 1;
  min-width: 0;
}
button.block-contact-option {
  width: 100%;
  padding: 7px 9px;
  --avatar-size: 34px;
}
.block-contact-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  color: var(--ui-muted);
}
.block-contact-empty {
  margin-block: 6px;
  color: var(--ui-muted);
}
</style>
