import { createApp, defineComponent, h, provide, shallowRef } from "vue";
import "../src/App.vue";
import ContactsPanel from "../src/features/contacts/ContactsPanel.vue";
import BlockedSettings from "../src/features/settings/BlockedSettings.vue";
import { chatKey } from "../src/composables/useChat";
import { settingsKey } from "../src/features/settings/useSettings";

// Actual profile/settings components with synthetic account and HTTP boundaries.
createApp(defineComponent({
  setup() {
    const me = shallowRef({ id: 1, internal_staff: false, formal_employee: true });
    const page = shallowRef("contacts"), revision = shallowRef(0);
    const peer = { id: 2, user_id: 2, nickname: "测试好友", username: "peer", public_id: "B".repeat(32),
      avatar_url: "", signature: "", is_contact: true, blocked_by_me: false, remark: "保留备注", group_name: "我的好友" };
    const writes: { path: string; body: any }[] = [];
    const blocks = shallowRef([{ blocked_id: 3, nickname: "已有屏蔽" }]);
    const contacts = shallowRef([{ ...peer }]);
    const noop = async () => {};
    const post = async (path: string, body: any) => {
      if (["/blocks", "/contacts/remove"].includes(path) && !me.value.internal_staff) throw Error("forbidden");
      writes.push({ path, body });
      if (path === "/blocks") peer.blocked_by_me = true;
      if (path === "/blocks/unblock") {
        peer.blocked_by_me = false;
        blocks.value = blocks.value.filter(item => item.blocked_id !== body.user_id);
      }
      return {};
    };
    const chat = {
      me, client: { token: "isolated-contact-policy", base: "https://fixture.invalid/api/v2" },
      active: shallowRef(null), locked: shallowRef(false), post,
      api: async (path: string, options?: any) => {
        if (path.startsWith("/contacts/profile")) return { ...peer };
        if (path.startsWith("/contacts/common-groups")) return { items: [] };
        if (path.startsWith("/contacts/internal-profile")) return { user_id: 2 };
        if (path === "/contacts/remark") {
          Object.assign(peer, options.body);
          writes.push({ path, body: options.body });
          return { remark: peer.remark, group_name: peer.group_name };
        }
        return { items: [] };
      },
      error: (error: unknown) => { throw error; }, rememberContactName() {},
      loadDirectory: noop, refreshNames: noop, refreshNotificationCount: noop,
    };
    const open = (next: string) => { page.value = next; revision.value++; };
    provide(chatKey, chat as any);
    provide(settingsKey, {
      chat, blocks, contacts, busy: shallowRef(false), contactsHasMore: shallowRef(false),
      contactsBusy: shallowRef(false), contactsError: shallowRef(""), loadMoreContacts: noop,
      open: async () => {}, task: async (operation: () => Promise<unknown>) => operation(),
    } as any);
    Object.assign(window, { contactPolicyFixture: {
      writes, open, setStaff: (allowed: boolean) => { me.value = { ...me.value, internal_staff: allowed }; },
    } });
    return () => h("main", page.value === "contacts"
      ? [h(ContactsPanel, { key: revision.value, userId: 2, onClose: () => open("settings") })]
      : [h(BlockedSettings, { key: revision.value })]);
  },
})).mount("#app");
