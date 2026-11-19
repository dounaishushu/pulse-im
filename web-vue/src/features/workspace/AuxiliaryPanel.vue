<script setup lang="ts">
import { inject, onMounted, shallowRef } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import UiIcon from "../../components/UiIcon.vue";
import { chatKey } from "../../composables/useChat";
import "../../../../web/vendor/qrcode.js";

declare global {
  interface Window {
    PulseQrCode: {
      toDataURL(
        value: string,
        options: { width: number; margin: number },
      ): Promise<string>;
    };
  }
}
const props = defineProps<{ mode: "qr" | "calls" }>();
const emit = defineEmits<{ close: []; "open-media-settings": [] }>();
const chat = inject(chatKey)!;
const qr = shallowRef("");
onMounted(() => {
  if (props.mode !== "qr") return;
  void window.PulseQrCode.toDataURL(
    "pulse://add-friend?public_id=" +
      encodeURIComponent(chat.me.value?.public_id || ""),
    { width: 280, margin: 2 },
  )
    .then((result) => (qr.value = result))
    .catch(chat.error);
});
</script>

<template>
  <BaseDialog
    :title="mode === 'qr' ? '我的二维码' : '通话记录'"
    size="compact"
    @close="emit('close')"
  >
    <div v-if="mode === 'qr'" class="vue-qr-panel">
      <img v-if="qr" :src="qr" alt="我的账号二维码" />
      <p>ID：{{ chat.me.value?.public_id }}</p>
    </div>
    <template v-else>
      <p>暂无通话记录。当前 Go 服务没有提供通话接口。</p>
      <button type="button" class="ui-text-button" @click="emit('open-media-settings')">
        <UiIcon name="settings" /> 通话设备设置
      </button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.vue-qr-panel {
  display: grid;
  justify-items: center;
  text-align: center;
}
.vue-qr-panel img {
  width: min(220px, 100%);
  height: auto;
  padding: 8px;
  background: #fff;
  border-radius: 8px;
}
</style>
