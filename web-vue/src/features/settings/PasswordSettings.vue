<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
const { busy, oldPassword, newPassword, confirmPassword, password } =
  useSettingsContext();
</script>
<template>
  <form class="vue-fields" @submit.prevent="password">
    <label
      >当前密码<input
        v-model="oldPassword"
        type="password"
        autocomplete="current-password"
        required /></label
    ><label
      >新密码<input
        v-model="newPassword"
        type="password"
        autocomplete="new-password"
        required
        minlength="8" /></label
    ><label
      >确认新密码<input
        v-model="confirmPassword"
        type="password"
        autocomplete="new-password"
        required /></label
    ><button class="primary" :disabled="busy">修改密码并重新登录</button>
  </form>
</template>
