<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
const { chat, busy, sessions, open, task } = useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <article
      v-for="session in sessions"
      :key="session.id"
      class="vue-contact-row"
    >
      <span
        >{{ session.device_name || session.device_type
        }}<small>{{ session.last_used_at }}</small></span
      ><em v-if="session.is_current">当前设备</em
      ><button
        v-else
        :disabled="busy"
        @click="
          task(async () => {
            await chat.post('/auth/sessions/revoke', {
              session_id: session.id,
            });
            await open('sessions');
          })
        "
      >
        移除设备
      </button>
    </article>
  </div>
</template>
