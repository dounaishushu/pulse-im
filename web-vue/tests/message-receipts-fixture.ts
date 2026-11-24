import { createApp, defineComponent, h, onMounted, provide, ref } from "vue";
import "../src/App.vue";
import MessageList from "../src/features/chat/MessageList.vue";
import { chatKey, useChat } from "../src/composables/useChat";
import { createClient } from "../src/api/client";
import type { Packet } from "../src/api/types";

const fixture = defineComponent({
  setup() {
    const client = createClient();
    client.session("receipt-fixture");
    let receive: ((packet: Packet) => void) | undefined;
    window.PulseGoRealtime.connect = async options => { receive = options.onPacket; return { close() {} }; };
    const foreground = ref(true), locked = ref(false);
    const chat = useChat(error => { throw error; }, () => {}, client, {
      config: ref({ register_require_avatar: false, force_update: false, minimum_version: "", latest_version: "" }),
      foreground, locked, logout: async () => {}, notifyOpen() {},
    });
    provide(chatKey, chat);
    Object.assign(window, { receiptFixture: { chat, client, foreground, locked, receive: (packet: Packet) => receive?.(packet) } });
    onMounted(async () => {
      await chat.initialize();
      await chat.choose(client.local("conversation", "00009001-eeee-4eee-8eee-eeeeeeeeeeee"));
    });
    return () => h("main", { class: "vue-workspace", style: "height:100dvh;display:flex;flex-direction:column;min-height:0;" }, [h(MessageList)]);
  },
});
createApp(fixture).mount("#app");
