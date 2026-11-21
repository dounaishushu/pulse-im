<script setup lang="ts">
import { onMounted, shallowRef, useTemplateRef } from "vue";
import { readLocalPasscode, saveLocalPasscode, hashLocalPasscode } from "./localPasscode";
const emit = defineEmits<{ unlocked: []; logout: [] }>();
const code = shallowRef(""),
  error = shallowRef(""),
  resolving = shallowRef(false);
const input = useTemplateRef<HTMLInputElement>("input");
onMounted(() => input.value?.focus());
async function unlock() {
  if (resolving.value) return;
  resolving.value = true;
  error.value = "";
  try {
    const saved = readLocalPasscode();
    if (!saved) throw Error("无法读取锁定设置，请重新登录。");
    if (await hashLocalPasscode(code.value) !== saved.hash) throw Error("锁定码不正确");
    saveLocalPasscode({ ...saved, locked: false });
    code.value = "";
    emit("unlocked");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "解锁失败";
    input.value?.select();
  } finally {
    resolving.value = false;
  }
}
</script>
<template>
  <Teleport to="body"
    ><main class="vue-lock-screen">
      <form role="dialog" aria-modal="true" aria-labelledby="local-lock-title" @submit.prevent="unlock">
        <h1 id="local-lock-title">小猿答疑 已锁定</h1>
        <input
          ref="input"
          v-model="code"
          type="password"
          inputmode="numeric"
          aria-label="锁定码"
          autocomplete="off"
          maxlength="12"
        />
        <p role="alert">{{ error }}</p>
        <button class="primary" :disabled="resolving">解锁</button
        ><button type="button" @click="emit('logout')">退出登录</button>
      </form>
    </main></Teleport
  >
</template>

<style scoped>
.vue-lock-screen {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: grid;
  place-items: center;
  padding: 13px;
  background: var(--ui-canvas);
}
.vue-lock-screen form {
  width: min(100%, 340px);
  display: grid;
  gap: 12px;
  padding: 22px;
  border: 1px solid var(--ui-line);
  border-radius: 8px;
  background: var(--ui-surface);
}
h1 {
  margin: 0;
  font-size: 16px;
}
input {
  width: 100%;
  padding: 8px 10px;
  color: var(--ui-text);
  background: var(--ui-fill);
  border: 1px solid var(--ui-line);
  border-radius: 6px;
}
[role="alert"] {
  color: var(--ui-danger);
}
[role="alert"]:empty {
  display: none;
}
</style>
