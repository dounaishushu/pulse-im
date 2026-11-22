// Isolated UI fixture: real workspace, chat state, outbox, and Go-v2 adapter.
// Only the HTTP server is substituted by the browser test; no live accounts.
import { createApp, defineComponent, h, onMounted, provide, ref } from "vue";
import "../src/App.vue";
import ChatWorkspace from "../src/features/workspace/ChatWorkspace.vue";
import { chatKey, useChat } from "../src/composables/useChat";
import { accountsKey } from "../src/composables/useSession";
import ConversationSidebar from "../src/features/chat/ConversationSidebar.vue";
import { useOutbox } from "../src/features/chat/useOutbox";
import { createClient } from "../src/api/client";

const fixture = defineComponent({
  setup() {
    const client = createClient();
    client.session("group-ui-fixture");
    window.PulseGoRealtime.connect = async () => ({ close() {} });
    const chat = useChat(error => { throw error; }, () => {}, client, {
      config: ref({ register_require_avatar: false, force_update: false, minimum_version: "", latest_version: "", show_group_member_count: true }),
      foreground: ref(true), locked: ref(false), logout: async () => {}, notifyOpen() {},
    });
    const outbox = useOutbox(chat);
    const directory = ref(false);
    const full = ref(false);
    provide(chatKey, chat);
    provide(accountsKey, { accountsOpen: ref(false) } as any);
    Object.assign(window, { groupFixture: { chat, client, directory, full } });
    onMounted(async () => {
      await chat.initialize();
      await chat.choose(client.local("conversation", "00009000-eeee-4eee-8eee-eeeeeeeeeeee"));
    });
    return () => full.value ? h(ChatWorkspace, { chat, outbox }) : directory.value
      ? h("div", { style: "display:flex;height:100vh;" }, [
          h("aside", { class: "fixture-conversations", style: "width:270px;flex:none;overflow:auto;" }, [h(ConversationSidebar)]),
          h("main", { style: "flex:1;min-width:0;" }, [h(ChatWorkspace, { chat, outbox, detached: true })]),
        ])
      : h(ChatWorkspace, { chat, outbox, detached: true });
  },
});
createApp(fixture).mount("#app");
