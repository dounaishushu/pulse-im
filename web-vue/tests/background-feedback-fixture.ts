// The real workspace, automatic requests, durable outbox and API adapter.
// Tests replace HTTP and realtime only; no production account is used.
import { createApp, defineComponent, h, onMounted, ref } from "vue";
import "../src/App.vue";
import ChatWorkspace from "../src/features/workspace/ChatWorkspace.vue";
import { useChat } from "../src/composables/useChat";
import { useOutbox } from "../src/features/chat/useOutbox";
import { createClient } from "../src/api/client";
import type { Packet } from "../src/api/types";

const fixture = defineComponent({
  setup() {
    const client = createClient();
    client.session("background-feedback-fixture");
    let receive: ((packet: Packet) => void) | undefined;
    window.PulseGoRealtime.connect = async options => {
      receive = options.onPacket;
      return { close() {} };
    };
    const failures: { message: string; status?: number }[] = [];
    const invalidations = ref(0), ready = ref(false);
    const foreground = ref(true), locked = ref(false);
    const chat = useChat(cause => failures.push({
      message: cause instanceof Error ? cause.message : String(cause),
      status: (cause as { status?: number })?.status,
    }), () => { invalidations.value++; }, client, {
      config: ref({ register_require_avatar: false, force_update: false, minimum_version: "", latest_version: "" }),
      foreground, locked, logout: async () => {}, notifyOpen() {},
    });
    const outbox = useOutbox(chat);
    Object.assign(window, { feedbackFixture: {
      chat, client, foreground, locked, failures, invalidations, ready,
      receive: (packet: Packet) => receive?.(packet),
      unmount: () => app.unmount(),
    } });
    onMounted(async () => {
      await chat.initialize();
      await chat.choose(client.local("conversation", "00009001-eeee-4eee-8eee-eeeeeeeeeeee"));
      ready.value = true;
    });
    return () => h(ChatWorkspace, { chat, outbox, detached: true });
  },
});
const app = createApp(fixture);
app.mount("#app");
