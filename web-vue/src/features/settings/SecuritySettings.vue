<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
const { busy, security, oldPassword, currentCode, newCode, twoStep } =
  useSettingsContext();
</script>
<template>
  <form
    class="vue-fields"
    @submit.prevent="twoStep(security.enabled ? 'change' : 'enable')"
  >
    <p>{{ security.enabled ? "已开启两步验证" : "未开启两步验证" }}</p>
    <label
      >登录密码<input
        v-model="oldPassword"
        type="password"
        required
        autocomplete="current-password" /></label
    ><label v-if="security.enabled"
      >当前两步密码<input v-model="currentCode" type="password" /></label
    ><label
      >新的两步密码<input
        v-model="newCode"
        type="password"
        minlength="8" /></label
    ><button class="primary" :disabled="busy">
      {{ security.enabled ? "修改" : "开启" }}</button
    ><button
      v-if="security.enabled"
      type="button"
      :disabled="busy"
      @click="twoStep('disable')"
    >
      关闭两步验证</button
    ><button
      v-if="security.enabled"
      type="button"
      :disabled="busy"
      @click="twoStep('rotate-recovery')"
    >
      重新生成恢复码
    </button>
    <pre v-if="security.recovery_codes?.length">{{
      security.recovery_codes.join("\n")
    }}</pre>
  </form>
</template>
