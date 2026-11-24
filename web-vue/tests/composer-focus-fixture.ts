// Exercise the real editor and send handler without a production account.
import { computed, createApp, defineComponent, h, provide, ref } from "vue";
import "../src/App.vue";
import MessageComposer from "../src/features/chat/MessageComposer.vue";
import { chatKey, type Chat } from "../src/composables/useChat";
import { outboxKey, type TextPayload } from "../src/features/chat/useOutbox";
import { createClient, messageOf } from "../src/api/client";

createApp(defineComponent({ setup() {
  const client = createClient();
  client.session("isolated-composer-focus");
  const active = ref({ id: 9001, type: "direct", can_send: true });
  const locked = ref(false), error = ref("");
  const sent: TextPayload[] = [];
  let delayed = false;
  let settle: ((error?: string) => void) | undefined;
  const chat = {
    client, active, locked, reply: ref(null), loading: ref(false),
    canSend: computed(() => !locked.value && active.value.can_send),
    me: ref({ id: 1, nickname: "我", internal_staff: false }),
    drafts: ref({}), interactionBusy: ref(false), mentionRequest: ref(null),
    openRevision: ref(0), shakeRevision: ref(0), sendRevision: ref(0),
    contactName: (_id: number, fallback: string) => fallback,
    messageText: (body: { text?: string }) => body.text || "",
    api: async () => ({ items: [] }),
    error: (cause: unknown) => { error.value = messageOf(cause); },
  } as unknown as Chat;
  provide(chatKey, chat);
  provide(outboxKey, {
    pending: ref([]), retry() {}, discard() {}, resume() {},
    send(payload: TextPayload) {
      sent.push(payload);
      if (!delayed) return;
      delayed = false;
      return new Promise<void>((resolve, reject) => {
        settle = error => error ? reject(new Error(error)) : resolve();
      });
    },
  });
  Object.assign(window, { focusFixture: {
    chat, sent, error,
    delayNext() { delayed = true; },
    finish(error?: string) { const done = settle; settle = undefined; done?.(error); },
  } });
  return () => h("main", { style: "display:flex;flex-direction:column;justify-content:end;height:100vh" }, [
    h("input", { "aria-label": "其他输入框" }),
    h("p", { role: "alert" }, error.value),
    h(MessageComposer, { desktop: true }),
  ]);
} })).mount("#app");
