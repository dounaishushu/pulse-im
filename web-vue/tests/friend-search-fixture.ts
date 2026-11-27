import { createApp, defineComponent, h, provide, shallowRef } from "vue";
import "../src/App.vue";
import ContactsPanel from "../src/features/contacts/ContactsPanel.vue";
import { chatKey } from "../src/composables/useChat";

createApp(defineComponent({
  setup() {
    const me = shallowRef({ id: 1, internal_staff: false });
    const calls: { path: string; body?: unknown }[] = [];
    const model = { friend: true, closeCount: 0 };
    const noop = async () => {};
    const peer = () => ({ id: 2, user_id: 2, nickname: "测试好友", username: "peer001", public_id: "B".repeat(32),
      is_contact: model.friend, can_add_friend: !model.friend, avatar_url: "", signature: "" });
    const chat = {
      me, locked: shallowRef(false), active: shallowRef(null),
      client: { token: "friend-search-fixture", base: "https://fixture.invalid/api/v2" },
      api: async (path: string, options?: any) => {
        calls.push({ path, body: options?.body });
        if (path.startsWith("/contacts/search")) return { items: [peer()], total: 1, page: 1, size: 1 };
        if (path === "/auth/me") return me.value;
        if (path === "/contacts/force-add") { model.friend = true; return { status: "accepted" }; }
        // Deliberately empty: search must not depend on the locally loaded friend page.
        return { items: [], total: 0, page: 1, size: 100 };
      },
      post: async (path: string, body: unknown) => { calls.push({ path, body }); return { id: 10 }; },
      choose: async (id: number) => { calls.push({ path: "choose", body: id }); },
      loadDirectory: noop, refreshNames: noop, refreshNotificationCount: noop,
      rememberContactName() {}, error(cause: unknown) { throw cause; },
    };
    provide(chatKey, chat as any);
    Object.assign(window, { friendSearchFixture: { calls, model, setStaff: (value: boolean) => { me.value = { ...me.value, internal_staff: value }; } } });
    return () => h(ContactsPanel, { initialSection: "search", onClose: () => { model.closeCount++; } });
  },
})).mount("#app");
