<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef, watch } from "vue";
import UiIcon from "../../components/UiIcon.vue";
import BlockContactPicker from "./BlockContactPicker.vue";
import { useSettingsContext } from "./useSettings";

const {
  chat,
  busy,
  blocks,
  contacts,
  contactsHasMore,
  contactsBusy,
  contactsError,
  loadMoreContacts,
  open,
  task,
} = useSettingsContext();
const selecting = shallowRef(false);
const canBlock = computed(() => chat.me.value?.internal_staff === true);
watch(canBlock, allowed => { if (!allowed) selecting.value = false; });
const addButton = useTemplateRef<HTMLButtonElement>("addButton");
const blockedIds = computed(
  () => new Set(blocks.value.map((item) => item.blocked_id)),
);
const available = computed(() =>
  contacts.value.filter((person) => !blockedIds.value.has(person.id)),
);
const labels = computed(() => new Map(
  contacts.value.map((person) => [
    person.id,
    person.remark || person.nickname || person.username || person.public_id,
  ]),
));

async function closePicker() {
  selecting.value = false;
  await nextTick();
  addButton.value?.focus({ preventScroll: true });
}

function block(id: number) {
  if (!canBlock.value) return;
  return task(async () => {
    if (!canBlock.value) return;
    await chat.post("/blocks", { user_id: id, reason: "隐私设置中屏蔽" });
    selecting.value = false;
    await open("blocked");
  });
}

function unblock(id: number) {
  return task(async () => {
    await chat.post("/blocks/unblock", { user_id: id });
    await open("blocked");
  });
}
</script>

<template>
  <div class="vue-settings-section blocked-settings">
    <BlockContactPicker
      v-if="selecting && canBlock"
      :contacts="available"
      :busy="busy"
      :has-more="contactsHasMore"
      :loading="contactsBusy"
      :load-error="contactsError"
      @load-more="loadMoreContacts"
      @block="block"
      @cancel="closePicker"
    />
    <template v-else>
      <div v-if="canBlock">
        <button
          ref="addButton"
          type="button"
          class="ui-text-button"
          :disabled="busy"
          @click="selecting = true"
        >
          <UiIcon name="plus" /> 添加屏蔽用户
        </button>
      </div>
      <p v-if="!blocks.length" class="blocked-empty">暂无已屏蔽用户</p>
      <article
        v-for="item in blocks"
        :key="item.blocked_id"
        class="vue-contact-row"
      >
        <span>{{ labels.get(item.blocked_id) || item.nickname }}</span>
        <button type="button" :disabled="busy" @click="unblock(item.blocked_id)">
          解除屏蔽
        </button>
      </article>
    </template>
  </div>
</template>

<style scoped>
.blocked-settings {
  display: grid;
  gap: 8px;
}
.blocked-empty {
  margin-block: 6px;
  color: var(--ui-muted);
}
</style>
