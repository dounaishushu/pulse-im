import { createApp, defineComponent, h, provide, ref } from "vue";
import "../src/App.vue";
import MessageComposer from "../src/features/chat/MessageComposer.vue";
import { chatKey, type Chat } from "../src/composables/useChat";
import { outboxKey } from "../src/features/chat/useOutbox";
import { createClient, messageOf } from "../src/api/client";
import { imageThumbnail, prepareImageUpload } from "../src/features/chat/localImage";

const fixture = defineComponent({ setup() {
  const client = createClient(); client.session("isolated-composer");
  const id = client.local("conversation", "00009000-eeee-4eee-8eee-eeeeeeeeeeee");
  const error = ref(""); const sent = ref<unknown[]>([]);
  const active = ref({ id, type: "direct", can_send: true });
  const chat = {
    client, active, reply: ref(null), canSend: ref(true), locked: ref(false), loading: ref(false),
    me: ref({ id: client.local("user", "00000001-eeee-4eee-8eee-eeeeeeeeeeee"), internal_staff: false }),
    drafts: ref({}), interactionBusy: ref(false), mentionRequest: ref(null), openRevision: ref(0),
    shakeRevision: ref(0), sendRevision: ref(0),
    api: (path: string, options = {}) => client.request(path, { deferMedia: path === "/messages", ...options }),
    post: (path: string, body: unknown) => client.request(path, { method: "POST", body }),
    summary: async () => {}, error: (cause: unknown) => { error.value = messageOf(cause); },
    mergeMessages: (items: unknown[]) => { sent.value.push(...items); },
  } as unknown as Chat;
  provide(chatKey, chat);
  provide(outboxKey, { pending: ref([]), send: async () => {}, retry: async () => {}, discard() {} } as never);
  Object.assign(window, { composerFixture: { chat, client, sent, error, imageThumbnail, prepareImageUpload } });
  return () => h("main", { style: "display:flex;flex-direction:column;justify-content:end;height:100vh;background:var(--ui-surface-soft)" }, [
    h("p", { role: "alert" }, error.value), h(MessageComposer, { desktop: true }),
  ]);
} });
createApp(fixture).mount("#app");
