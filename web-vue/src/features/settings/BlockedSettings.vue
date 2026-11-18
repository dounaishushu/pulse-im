<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
const { chat, busy, blocks, open, task } = useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <article
      v-for="item in blocks"
      :key="item.blocked_id"
      class="vue-contact-row"
    >
      <span>{{ item.nickname }}</span><button
        :disabled="busy"
        @click="
          task(async () => {
            await chat.post('/blocks/unblock', { user_id: item.blocked_id });
            await open('blocked');
          })
        "
      >
        解除屏蔽
      </button>
    </article>
  </div>
</template>
