<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
const { busy, lockCurrent, lockNext, lockConfirm, lockCode } =
  useSettingsContext();
</script>
<template>
  <form class="vue-fields" @submit.prevent="lockCode()">
    <label
      >当前锁定码<input
        v-model="lockCurrent"
        type="password"
        autocomplete="off" /></label
    ><label
      >新锁定码<input
        v-model="lockNext"
        type="password"
        inputmode="numeric" /></label
    ><label
      >确认锁定码<input
        v-model="lockConfirm"
        type="password"
        inputmode="numeric" /></label
    ><button class="primary" :disabled="busy">保存锁定码</button
    ><button type="button" :disabled="busy" @click="lockCode(true)">
      关闭锁定码
    </button>
  </form>
</template>
