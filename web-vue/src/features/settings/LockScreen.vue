<script setup lang="ts">
import { shallowRef } from "vue";
const emit = defineEmits<{ unlocked: []; logout: [] }>();
const code = shallowRef(""),
  error = shallowRef("");
async function unlock() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("pulse_lock_settings") || "{}",
    );
    if (!saved.enabled) {
      emit("unlocked");
      return;
    }
    const hash = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(code.value),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== saved.hash) throw Error("锁定码不正确");
    localStorage.setItem(
      "pulse_lock_settings",
      JSON.stringify({ ...saved, locked: false }),
    );
    code.value = "";
    emit("unlocked");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "解锁失败";
  }
}
</script>
<template>
  <Teleport to="body"
    ><main class="vue-lock-screen">
      <form @submit.prevent="unlock">
        <h1>小猿答疑 已锁定</h1>
        <input
          v-model="code"
          type="password"
          inputmode="numeric"
          aria-label="锁定码"
          autocomplete="off"
        />
        <p role="alert">{{ error }}</p>
        <button class="primary">解锁</button
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
