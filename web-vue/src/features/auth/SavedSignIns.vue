<script setup lang="ts">
import { onMounted, onScopeDispose, shallowRef } from "vue";
import platform from "virtual:pulse-platform";
import UiIcon from "../../components/UiIcon.vue";
import type { RememberedSignIn, SignInDetails } from "../../platform/contracts";

const props = defineProps<{ busy: boolean }>();
const remember = defineModel<boolean>({ required: true });
const emit = defineEmits<{
  selected: [value: SignInDetails];
  forgotten: [account: string];
}>();
const signIns = platform.signIns!;
const rows = shallowRef<RememberedSignIn[]>([]);
const open = shallowRef(false);
const working = shallowRef(false);
const error = shallowRef("");
let active = true;

async function refresh() {
  const items = await signIns.list();
  if (!active) return;
  rows.value = items;
  if (!items.length) open.value = false;
}
async function select(id: string) {
  if (props.busy || working.value) return;
  working.value = true;
  error.value = "";
  try {
    const value = await signIns.read(id);
    if (active && value && !props.busy) {
      remember.value = true;
      emit("selected", value);
      open.value = false;
    }
  } catch {
    if (active) error.value = "暂时无法读取此账号。";
  } finally {
    working.value = false;
  }
}
async function remove(row: RememberedSignIn) {
  if (props.busy || working.value) return;
  working.value = true;
  error.value = "";
  try {
    await signIns.forget(row.id);
    if (!active) return;
    emit("forgotten", row.account);
    await refresh();
  } catch {
    if (active) error.value = "无法移除此账号，请重试。";
  } finally {
    working.value = false;
  }
}
onMounted(() => {
  void refresh().catch(() => {
    if (active) error.value = "暂时无法读取本机已保存的账号。";
  });
});
onScopeDispose(() => { active = false; });
</script>

<template>
  <div class="saved-login" @keydown.esc.stop="open = false">
    <div class="saved-login-controls">
      <label class="save-choice">
        <input v-model="remember" type="checkbox" :disabled="busy || working" />记住密码
      </label>
      <button
        v-if="rows.length"
        type="button"
        class="saved-toggle"
        :aria-expanded="open"
        :disabled="busy || working"
        @click="open = !open"
      >已保存账号 <UiIcon name="chevron" /></button>
    </div>
    <ul v-if="open" class="saved-entries" aria-label="本机已保存的账号">
      <li v-for="row in rows" :key="row.id">
        <button type="button" class="account-choice" :disabled="busy || working" @click="select(row.id)">
          <UiIcon name="profile" /> <span>{{ row.account }}</span>
        </button>
        <button type="button" class="account-remove" :aria-label="'移除 ' + row.account" :disabled="busy || working" @click="remove(row)">
          <UiIcon name="close" />
        </button>
      </li>
    </ul>
    <p v-if="error" class="saved-login-error" role="status">{{ error }}</p>
  </div>
</template>

<style scoped>
.saved-login {
  position: relative;
}
.saved-login-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--ui-muted);
  font-size: var(--ui-font-control);
}
.saved-login-controls .save-choice {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.saved-login-controls .save-choice input {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--ui-primary);
}
.saved-login button {
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.saved-toggle {
  min-height: 30px;
  padding-inline: 6px;
}
.saved-toggle .ui-icon {
  transform: rotate(90deg);
}
.saved-entries {
  position: absolute;
  z-index: 3;
  inset-inline: 0;
  top: 100%;
  display: grid;
  gap: 2px;
  max-height: 180px;
  overflow: auto;
  margin: 4px 0 0;
  padding: 6px;
  border-radius: 9px;
  background: var(--ui-surface);
  box-shadow: var(--ui-popover-shadow);
  list-style: none;
}
.saved-entries li {
  display: flex;
  gap: 2px;
}
.saved-entries button {
  min-height: 32px;
}
.saved-entries button:hover {
  background: var(--art-hover-color);
}
.account-choice {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  padding-inline: 7px;
  text-align: start;
}
.account-choice span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-remove {
  padding-inline: 8px;
  color: var(--ui-muted);
}
.saved-login-error {
  margin: 4px 0 0;
  color: var(--ui-danger);
}
</style>
