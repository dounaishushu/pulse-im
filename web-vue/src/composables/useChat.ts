import {
  computed,
  onScopeDispose,
  shallowRef,
  watch,
  type Ref,
  type InjectionKey,
} from "vue";
import { useNotifications } from "./useNotifications";
import "../../../web/friend-chats.js";
import "../../../web/contact-names.js";
import "../../../web/conversation-refresh.js";
import {
  messageOf,
  WEB_VERSION,
  type Client,
  type Config,
} from "../api/client";
import type {
  Profile,
  Conversation,
  Message,
  Page,
  Folder,
  History,
  Cursor,
  Packet,
} from "../api/types";

interface AccountContext {
  token: string;
  userId: number;
  base?: string;
  nickname?: string;
  allowed?: boolean;
}
interface NamesService {
  refresh(options?: { force: boolean }): Promise<boolean>;
  resolve(id: number, fallback?: string): string;
  conversations(rows: Conversation[]): void;
  clear(): void;
}
interface DirectoryUpdate {
  items: Conversation[];
  removed_ids: number[];
  incremental?: boolean;
}
declare global {
  interface Window {
    PulseContactNames: {
      create(options: {
        context(): AccountContext;
        request(
          path: string,
          options: { authToken: string; signal: AbortSignal },
        ): Promise<Page<Profile>>;
        changed(): void;
      }): NamesService;
    };
    PulseConversationRefresh: {
      create(options: {
        account(): AccountContext;
        load(ids: number[], account: AccountContext): Promise<DirectoryUpdate>;
        apply(result: DirectoryUpdate, account: AccountContext): void;
        full(): Promise<void>;
        failed(error: unknown): void;
      }): { hint(ids: number[]): void; flush(): Promise<void>; reset(): void };
    };
  }
}
interface FriendChatEvent {
  id: number;
  conversation_id: number;
  peer_user_id: number;
}
declare global {
  interface Window {
    PulseFriendChats: {
      create(options: {
        context(): {
          token: string;
          userId: number;
          base: string;
          allowed: boolean;
          syncAllowed: boolean;
        };
        storage: Storage;
        request(
          path: string,
          options: { authToken: string },
        ): Promise<{ items: FriendChatEvent[] }>;
        synchronize(
          event: FriendChatEvent,
          account: unknown,
          current: () => boolean,
        ): Promise<boolean>;
        open(
          event: FriendChatEvent,
          account: unknown,
          current: () => boolean,
        ): Promise<boolean>;
      }): { refresh(): Promise<void>; changed(): void };
    };
  }
}
export type Panel =
  | "none"
  | "contacts"
  | "create-group"
  | "create-channel"
  | "join"
  | "settings"
  | "group"
  | "search"
  | "notifications"
  | "qr"
  | "calls"
  | "broadcast";
export function useChat(
  failed: (error: unknown) => void,
  loginRequired: () => void,
  client: Client,
  options: {
    foreground: Ref<boolean>;
    locked: Ref<boolean>;
    logout(): Promise<void>;
    notifyOpen(id: number): void;
  },
) {
  const foreground = options.foreground;
  const config = shallowRef<Config | null>(null);
  const me = shallowRef<Profile | null>(null),
    conversations = shallowRef<Conversation[]>([]),
    folders = shallowRef<Folder[]>([]);
  const active = shallowRef<Conversation | null>(null),
    messages = shallowRef<Message[]>([]),
    pins = shallowRef<Message[]>([]);
  const loading = shallowRef(false),
    olderLoading = shallowRef(false),
    hasMore = shallowRef(false),
    issue = shallowRef(""),
    search = shallowRef("");
  const tab = shallowRef<"messages" | "friends" | "groups">("messages"),
    archived = shallowRef(false),
    panel = shallowRef<Panel>("none");
  const reply = shallowRef<Message | null>(null),
    connected = shallowRef(false),
    sendRevision = shallowRef(0),
    locked = options.locked;
  const mentionRequest = shallowRef<{
    user: number;
    name: string;
    revision: number;
  } | null>(null);
  const openRevision = shallowRef(0);
  const interactionBusy = shallowRef(false);
  const { totalUnread, notificationUnread } = useNotifications(
    conversations,
    me,
    locked,
    options.notifyOpen,
    foreground,
  );
  const contactCard = shallowRef<{
    conversation: number;
    message: number;
  } | null>(null);
  const contactContext = shallowRef<number | undefined>();
  const contactId = shallowRef<number | undefined>();
  const selection = shallowRef<number[]>([]);
  const located = shallowRef<number | null>(null);
  const nameRevision = shallowRef(0);
  const drafts = shallowRef<Record<number, string>>({});
  async function refreshNames() {
    try {
      await names.refresh({ force: true });
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) error(cause);
    }
  }
  function contactName(id: number, fallback = "会话成员") {
    void nameRevision.value;
    return names.resolve(id, fallback);
  }
  let socket: { close(): void } | undefined,
    epoch = 0,
    cursor: Cursor | null = null,
    disposed = false,
    syncing = false,
    syncAgain = false,
    directoryFlight = false;
  let initialReady = false,
    networkNext = 0,
    networkFlight = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let navigation = new AbortController();
  const lifetime = new AbortController();
  const token = client.token;
  const api = <T>(
    path: string,
    options: Parameters<Client["request"]>[1] = {},
  ) =>
    client.request<T>(path, {
      ...options,
      signal:
        options.signal ||
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]),
    });
  const post = <T>(path: string, body: unknown) =>
    api<T>(path, { method: "POST", body });
  function error(cause: unknown) {
    if (disposed) return;
    if ((cause as { status?: number }).status === 401) loginRequired();
    else if ((cause as { status?: number }).status === 426) failed(cause);
    else issue.value = messageOf(cause);
  }
  const visible = computed(() =>
    conversations.value.filter(
      (row) =>
        !row.is_hidden &&
        row.type !== "favorites" &&
        Boolean(row.is_archived) === archived.value &&
        (tab.value !== "groups" || row.type !== "direct") &&
        (!search.value ||
          (row.name + textOfLast(row))
            .toLowerCase()
            .includes(search.value.toLowerCase())),
    ),
  );
  const canSend = computed(
    () => !!active.value && active.value.can_send !== false && !locked.value,
  );
  const current = (ticket: number, id: number) =>
    !disposed &&
    token === client.token &&
    epoch === ticket &&
    active.value?.id === id;
  function mergeMessages(incoming: Message[], replace = false, floor = 0) {
    const map = new Map<number, Message>(
      replace
        ? []
        : messages.value
            .filter((row) => row.id > floor)
            .map((row) => [row.id, row]),
    );
    for (const row of incoming) {
      if (row.conversation_id !== active.value?.id || row.id <= floor) continue;
      const previous = map.get(row.id);
      if (
        previous &&
        Number(previous.body._go_version) > Number(row.body._go_version)
      )
        continue;
      map.set(
        row.id,
        previous && JSON.stringify(previous) === JSON.stringify(row)
          ? previous
          : row,
      );
    }
    messages.value = [...map.values()].sort((a, b) => a.id - b.id);
  }
  const friendChats = window.PulseFriendChats.create({
    storage: localStorage,
    context: () => ({
      token: disposed ? "" : token,
      userId: me.value?.id || 0,
      base: client.base,
      syncAllowed: !disposed && !locked.value,
      allowed:
        !disposed &&
        !document.hidden &&
        !locked.value &&
        foreground.value &&
        panel.value === "none" &&
        !interactionBusy.value,
    }),
    request: (path, options) => api(path, options),
    synchronize: async (_event, _account, current) => {
      await loadDirectory();
      if (foreground.value) void refreshNames();
      void refreshNotificationCount();
      return current();
    },
    open: async (event, _account, current) => {
      if (!current()) return false;
      await choose(event.conversation_id);
      return (
        current() &&
        active.value?.id === event.conversation_id &&
        !loading.value &&
        !issue.value
      );
    },
  });
  async function refreshNotificationCount() {
    try {
      const result = await api<{ unread_count: number }>(
        "/notifications/summary",
      );
      if (!disposed) notificationUnread.value = result.unread_count;
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) error(cause);
    }
  }
  let updateFlight = false;
  async function checkUpdate() {
    if (disposed || updateFlight) return;
    updateFlight = true;
    try {
      const value = await client.raw<{ required: boolean; notes?: string }>(
        "/client/update?platform=web&version=" + WEB_VERSION,
        {
          authToken: "",
          signal: AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      if (!disposed && value.required) {
        locked.value = true;
        socket?.close();
        failed(Error(value.notes || "网页版本需要更新，请刷新页面加载新版。"));
      }
    } catch (cause) {
      if ((cause as { status?: number }).status === 426 && !disposed)
        failed(cause);
    } finally {
      updateFlight = false;
    }
  }
  async function loadDirectory() {
    if (directoryFlight || disposed) return;
    directoryFlight = true;
    try {
      const rows: Conversation[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = await api<Page<Conversation>>(
          `/conversations?page=${page}&size=100`,
        );
        rows.push(...result.items);
        if (
          result.items.length < 100 ||
          (result.total != null && rows.length >= result.total)
        )
          break;
      }
      const groups = await api<Page<Folder>>("/conversation-folders");
      if (disposed) return;
      conversations.value = rows;
      names.conversations(rows);
      folders.value = groups.items;
      const newer = rows.find((row) => row.id === active.value?.id);
      if (newer) active.value = { ...active.value, ...newer };
    } catch (cause) {
      error(cause);
    } finally {
      directoryFlight = false;
    }
  }
  function applySummaries(result: DirectoryUpdate) {
    if (disposed) return;
    const removed = new Set(result.removed_ids),
      updated = new Map(result.items.map((row) => [row.id, row]));
    const next = conversations.value
      .filter((row) => !removed.has(row.id))
      .map((row) => {
        const value = updated.get(row.id);
        updated.delete(row.id);
        return value || row;
      });
    next.push(...updated.values());
    conversations.value = next.sort(
      (a, b) =>
        Number(!!b.is_pinned) - Number(!!a.is_pinned) ||
        String(b.updated_at).localeCompare(String(a.updated_at)),
    );
    names.conversations(next);
    if (active.value && removed.has(active.value.id)) {
      navigation.abort();
      epoch++;
      active.value = null;
      messages.value = [];
      pins.value = [];
      cursor = null;
      loading.value = false;
    }
    const row = next.find((row) => row.id === active.value?.id);
    if (row) active.value = { ...active.value, ...row };
  }
  const names = window.PulseContactNames.create({
    context: () => ({
      token: disposed ? "" : token,
      userId: me.value?.id || 0,
      base: client.base,
      nickname: me.value?.nickname,
      allowed: !locked.value,
    }),
    request: (path, options) => api(path, options),
    changed: () => {
      nameRevision.value++;
    },
  });
  const directoryRefresh = window.PulseConversationRefresh.create({
    account: () => ({
      token: disposed ? "" : token,
      userId: me.value?.id || 0,
    }),
    load: (ids) => api("/conversations/updates?ids=" + ids.join(",")),
    apply: applySummaries,
    full: loadDirectory,
    failed: error,
  });
  function summary(ids: number[]) {
    directoryRefresh.hint(ids);
  }
  async function choose(id: number) {
    if (!foreground.value || disposed) return;
    openRevision.value++;
    void names.refresh().catch(() => {});
    if (
      active.value?.id === id &&
      !loading.value &&
      initialReady &&
      messages.value.length &&
      !located.value
    ) {
      void sync();
      return;
    }
    navigation.abort();
    navigation = new AbortController();
    const ticket = ++epoch;
    issue.value = "";
    located.value = null;
    olderLoading.value = false;
    reply.value = null;
    selection.value = [];
    active.value = conversations.value.find((row) => row.id === id) || {
      id,
      name: "正在加载…",
      type: "direct",
      message_seq: 0,
    };
    active.value = { ...active.value, can_send: false };
    messages.value = [];
    pins.value = [];
    loading.value = true;
    cursor = null;
    initialReady = false;
    hasMore.value = false;
    try {
      const info = await api<Conversation>("/conversations/open", {
        method: "POST",
        body: { conversation_id: id },
        signal: AbortSignal.any([
          navigation.signal,
          AbortSignal.timeout(15000),
        ]),
      });
      if (!current(ticket, id)) return;
      active.value = info;
      if (info.type === "group" || info.type === "channel")
        void api<Conversation>(
          "/conversations/groups/profile?conversation_id=" + id,
        )
          .then((profile) => {
            if (current(ticket, id))
              active.value = { ...active.value, ...profile };
          })
          .catch((cause) => {
            if (
              current(ticket, id) &&
              (cause as { status?: number }).status === 401
            )
              error(cause);
          });
      const page = await api<History>(
        "/messages/history?conversation_id=" + id + "&size=50",
        {
          signal: AbortSignal.any([
            navigation.signal,
            AbortSignal.timeout(15000),
          ]),
          onHistoryPage: (preview) => {
            if (current(ticket, id)) {
              initialReady = true;
              mergeMessages(
                preview.items,
                true,
                preview.cleared_before_message_id,
              );
              hasMore.value = preview.has_more === true;
            }
          },
        },
      );
      if (!current(ticket, id)) return;
      initialReady = true;
      mergeMessages(
        [
          ...page.items,
          ...messages.value.filter((row) => row.id > page.snapshot_max_id),
        ],
        true,
        page.cleared_before_message_id,
      );
      hasMore.value = page.has_more === true;
      if (
        info.event_seq != null &&
        info.membership_version === page.membership_version
      )
        cursor = {
          events: Number(info.event_seq),
          personal: Number(info.state?.personal_seq || 0),
          membership: page.membership_version,
        };
      localStorage.setItem("pulse_vue_last_chat:" + me.value!.id, String(id));
      void loadPins(id, ticket);
      void sync();
    } catch (cause) {
      if (!navigation.signal.aborted && current(ticket, id)) error(cause);
    } finally {
      if (current(ticket, id)) {
        loading.value = false;
        void sync();
      }
    }
  }
  async function locate(message: Message) {
    if (active.value?.id !== message.conversation_id)
      await choose(message.conversation_id);
    const ticket = epoch;
    const page = await api<History>(
      "/messages/locate?conversation_id=" +
        message.conversation_id +
        "&message_id=" +
        message.id,
    );
    if (current(ticket, message.conversation_id)) {
      located.value = message.id;
      mergeMessages(page.items, true, page.cleared_before_message_id);
      hasMore.value = true;
    }
  }
  async function loadPins(id = active.value?.id, ticket = epoch) {
    if (!id) return;
    try {
      const value = await api<Page<Message>>(
        "/messages/pins?conversation_id=" + id,
      );
      if (current(ticket, id)) pins.value = value.items;
    } catch (cause) {
      if (current(ticket, id)) error(cause);
    }
  }
  async function older() {
    const id = active.value?.id,
      ticket = epoch;
    if (!id || olderLoading.value || !hasMore.value || !messages.value.length)
      return;
    olderLoading.value = true;
    try {
      await api("/conversations/info?conversation_id=" + id);
      const page = await api<History>(
        `/messages/history?conversation_id=${id}&max_id=${messages.value[0]!.id - 1}&size=50`,
      );
      if (current(ticket, id)) {
        mergeMessages(page.items, false, page.cleared_before_message_id);
        hasMore.value = page.has_more === true;
      }
    } catch (cause) {
      if (current(ticket, id)) error(cause);
    } finally {
      if (current(ticket, id)) olderLoading.value = false;
    }
  }
  async function sync() {
    const id = active.value?.id,
      ticket = epoch;
    if (
      !id ||
      !foreground.value ||
      disposed ||
      document.hidden ||
      locked.value ||
      loading.value ||
      located.value != null
    )
      return;
    if (!initialReady) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (current(ticket, id)) void choose(id);
      }, 1500);
      return;
    }
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    try {
      if (cursor) {
        const change = await client.delta(id, cursor, {
          signal: AbortSignal.any([
            navigation.signal,
            AbortSignal.timeout(15000),
          ]),
          current: () => current(ticket, id),
        });
        if (!current(ticket, id)) return;
        cursor = change.cursor;
        if (!change.needs_snapshot) {
          mergeMessages(change.items, false, change.cleared_before_message_id);
          return;
        }
      }
      const floor = Math.max(0, (messages.value[0]?.id || 1) - 1);
      let after = 0;
      const rows: Message[] = [];
      let snapshot: number | undefined,
        membership: number | undefined,
        cleared = 0;
      for (let page = 0; page < 100; page++) {
        const qs = new URLSearchParams({
          conversation_id: String(id),
          floor_id: String(floor),
          after_id: String(after),
          limit: "100",
        });
        if (snapshot != null) {
          qs.set("snapshot_max_id", String(snapshot));
          qs.set("membership_version", String(membership));
        }
        const data = await api<History & { next_after_id: number }>(
          "/messages/sync?" + qs,
          {
            signal: AbortSignal.any([
              navigation.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        );
        if (!current(ticket, id)) return;
        if (
          snapshot != null &&
          (snapshot !== data.snapshot_max_id ||
            membership !== data.membership_version)
        )
          throw Error("消息同步快照已变化，请重试");
        snapshot = data.snapshot_max_id;
        membership = data.membership_version;
        cleared = data.cleared_before_message_id;
        rows.push(...data.items);
        if (!data.has_more) break;
        if (data.next_after_id <= after) throw Error("消息同步游标无效");
        after = data.next_after_id;
      }
      if (current(ticket, id))
        mergeMessages(
          [
            ...rows,
            ...messages.value.filter((row) => row.id > (snapshot || 0)),
          ],
          true,
          cleared,
        );
    } catch (cause) {
      if (current(ticket, id)) {
        if ([403, 404].includes((cause as { status?: number }).status || 0)) {
          messages.value = [];
          pins.value = [];
        }
        if ((cause as { status?: number }).status === 409) {
          cursor = null;
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            void sync();
          }, 1000);
        } else if (!navigation.signal.aborted) error(cause);
      }
    } finally {
      syncing = false;
      if (syncAgain) {
        syncAgain = false;
        void sync();
      }
    }
  }
  function deleteLocally(ids: number[]) {
    const removed = new Set(ids);
    messages.value = messages.value
      .filter((row) => !removed.has(row.id))
      .map((row) =>
        row.body.reply_to && removed.has(row.body.reply_to.id)
          ? {
              ...row,
              body: {
                ...row.body,
                reply_to: { id: row.body.reply_to.id, unavailable: true },
              },
            }
          : row,
      );
    pins.value = pins.value.filter((row) => !removed.has(row.id));
    selection.value = selection.value.filter((id) => !removed.has(id));
    if (reply.value && removed.has(reply.value.id)) reply.value = null;
    void loadPins();
    void sync();
    if (active.value) void summary([active.value.id]);
  }
  async function refresh() {
    await loadDirectory();
    if (active.value) await sync();
  }
  async function packet(value: Packet) {
    if (disposed) return;
    if (value.type === "connection.error" && value.status === 401) {
      loginRequired();
      return;
    }
    if (value.type === "ready") {
      connected.value = true;
      void refresh();
      if (foreground.value) void friendChats.refresh();
      void refreshNotificationCount();
      if (foreground.value) void checkUpdate();
      return;
    }
    if (value.type === "connection.lost") {
      connected.value = false;
      void sync();
      return;
    }
    if (!value.conversation_id) {
      if (foreground.value) void friendChats.refresh();
      void refreshNotificationCount();
      void probeDirectory();
      return;
    }
    const id = value.conversation_id
      ? client.local("conversation", value.conversation_id)
      : 0;
    if (id) void summary([id]);
    if (id === active.value?.id) {
      if (value.type === "membership.changed") {
        await permissions();
        void sync();
      } else if (value.type !== "state.changed") {
        void sync();
        if (value.type.includes("pin")) void loadPins();
      }
    }
  }
  let initialization: Promise<void> | undefined;
  function initialize() {
    if (initialization) return initialization;
    initialization = initializeAccount().finally(() => {
      initialization = undefined;
    });
    return initialization;
  }
  async function initializeAccount() {
    try {
      const initial = await Promise.all([
        api<Profile>("/auth/me"),
        api<Config>("/client/config", { authToken: "" }),
      ]);
      if (disposed) return;
      me.value = initial[0];
      config.value = initial[1];
      if (foreground.value) void refreshNames();
      void refreshNotificationCount();
      await loadDirectory();
      if (disposed) return;
      socket?.close();
      socket = await window.PulseGoRealtime.connect({
        api: client,
        token,
        onPacket: (value) => {
          void packet(value);
        },
        shared: !!navigator.locks && typeof BroadcastChannel !== "undefined",
      });
      if (disposed) {
        socket.close();
        return;
      }
      const remembered = Number(
        localStorage.getItem("pulse_vue_last_chat:" + me.value.id),
      );
      if (
        foreground.value &&
        !locked.value &&
        conversations.value.some((row) => row.id === remembered)
      )
        void choose(remembered);
      void observeNetwork();
    } catch (cause) {
      if (!disposed) {
        if ((cause as { status?: number }).status === 401) loginRequired();
        else failed(cause);
      }
    }
  }
  async function observeNetwork() {
    if (
      disposed ||
      networkFlight ||
      document.hidden ||
      locked.value ||
      Date.now() < networkNext
    )
      return;
    networkFlight = true;
    networkNext = Date.now() + 300000;
    try {
      await client.raw("/client/network-observation", {
        method: "POST",
        body: { client_version: WEB_VERSION },
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
      });
      networkNext = Date.now() + 1800000;
    } catch {
    } finally {
      networkFlight = false;
    }
  }
  async function read(through: number) {
    const id = active.value?.id;
    if (
      !id ||
      !foreground.value ||
      document.hidden ||
      !document.hasFocus() ||
      locked.value ||
      loading.value
    )
      return false;
    try {
      await post("/messages/receipt", {
        conversation_id: id,
        through_message_id: through,
      });
      void summary([id]);
      return true;
    } catch (cause) {
      error(cause);
      return false;
    }
  }
  async function mutate(path: string, body: unknown) {
    const value = await post(path, body);
    await refresh();
    return value;
  }
  async function logout() {
    await options.logout();
  }
  let presenceFlight = false;
  async function presence() {
    if (
      presenceFlight ||
      disposed ||
      !foreground.value ||
      document.hidden ||
      locked.value
    )
      return;
    const rows = conversations.value
      .filter((row) => row.type === "direct" && row.peer_user_id)
      .slice(0, 100);
    if (!rows.length) return;
    presenceFlight = true;
    try {
      const result = await post<{
        items: {
          id: number;
          peer_online: boolean | null;
          peer_last_seen_hidden: boolean;
        }[];
      }>("/conversations/presence", {
        items: rows.map((row) => ({
          conversation_id: row.id,
          peer_user_id: row.peer_user_id,
        })),
      });
      if (disposed) return;
      const byId = new Map(result.items.map((row) => [row.id, row]));
      conversations.value = conversations.value.map((row) =>
        byId.has(row.id) ? { ...row, ...byId.get(row.id) } : row,
      );
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) error(cause);
    } finally {
      presenceFlight = false;
    }
  }
  let activeConversationBeforeHide = 0;
  watch(
    foreground,
    (show) => {
      if (!show) {
        activeConversationBeforeHide = active.value?.id || 0;
        navigation.abort();
        epoch++;
        loading.value = false;
        panel.value = "none";
        interactionBusy.value = false;
        return;
      }
      if (!me.value || disposed || locked.value) return;
      void refreshNames();
      void refreshNotificationCount();
      void probeDirectory();
      const remembered = Number(
        localStorage.getItem("pulse_vue_last_chat:" + me.value.id),
      );
      const id = activeConversationBeforeHide || remembered;
      activeConversationBeforeHide = 0;
      if (id && conversations.value.some((row) => row.id === id)) {
        active.value = null;
        void choose(id);
      }
    },
    { flush: "sync" },
  );
  const onResume = () => {
    if (!document.hidden) {
      void sync();
      void summary(conversations.value.slice(0, 100).map((row) => row.id));
      void presence();
      if (foreground.value) void friendChats.refresh();
      void refreshNotificationCount();
      if (foreground.value) void checkUpdate();
    }
  };
  window.addEventListener("online", onResume, { signal: lifetime.signal });
  document.addEventListener("visibilitychange", onResume, {
    signal: lifetime.signal,
  });
  let probeFlight = false,
    lastFull = Date.now(),
    lastPresence = 0;
  async function probeDirectory() {
    if (probeFlight || disposed || document.hidden || locked.value) return;
    probeFlight = true;
    try {
      const changed = await client.directoryChanges(conversations.value, {
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
        current: () => !disposed && !document.hidden && !locked.value,
      });
      if (changed.length > 100) await loadDirectory();
      else if (changed.length) void summary(changed);
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) error(cause);
    } finally {
      probeFlight = false;
    }
  }
  async function permissions() {
    const id = active.value?.id,
      ticket = epoch;
    if (!foreground.value || !id || active.value?.type === "direct") return;
    try {
      const info = await api<Conversation>(
        "/conversations/info?conversation_id=" + id,
      );
      if (current(ticket, id)) active.value = { ...active.value, ...info };
    } catch (cause) {
      if (
        current(ticket, id) &&
        [401, 403, 404].includes((cause as { status?: number }).status || 0)
      ) {
        messages.value = [];
        active.value = { ...active.value!, can_send: false };
        error(cause);
      }
    }
  }
  let lastBackgroundProbe = 0;
  const timer = setInterval(() => {
    if (document.hidden || locked.value || disposed) return;
    if (!foreground.value) {
      if (Date.now() - lastBackgroundProbe < 60000) return;
      lastBackgroundProbe = Date.now();
    }
    void sync();
    void probeDirectory();
    void permissions();
    if (foreground.value) void friendChats.refresh();
    void refreshNotificationCount();
    void observeNetwork();
    if (Date.now() - lastPresence > 30000) {
      lastPresence = Date.now();
      void presence();
    }
    if (Date.now() - lastFull > 300000) {
      lastFull = Date.now();
      void loadDirectory();
      if (foreground.value) void refreshNames();
      if (foreground.value) void checkUpdate();
    }
  }, 15000);
  onScopeDispose(() => {
    disposed = true;
    epoch++;
    lifetime.abort();
    navigation.abort();
    socket?.close();
    directoryRefresh.reset();
    names.clear();
    clearTimeout(retryTimer);
    clearInterval(timer);
  });
  return {
    client,
    foreground,
    sessionInvalidated: loginRequired,
    me,
    config,
    conversations,
    folders,
    active,
    messages,
    pins,
    loading,
    olderLoading,
    hasMore,
    issue,
    search,
    tab,
    archived,
    panel,
    reply,
    connected,
    sendRevision,
    locked,
    visible,
    canSend,
    contactId,
    contactCard,
    contactContext,
    mentionRequest,
    selection,
    api,
    post,
    error,
    initialize,
    choose,
    refresh,
    loadDirectory,
    summary,
    mergeMessages,
    deleteLocally,
    sync,
    older,
    read,
    mutate,
    logout,
    loadPins,
    presence,
    refreshNames,
    contactName,
    drafts,
    located,
    locate,
    interactionBusy,
    openRevision,
    totalUnread,
    notificationUnread,
    refreshNotificationCount,
    checkUpdate,
  };
}
function textOfLast(row: Conversation) {
  return row.last_message?.body.text || "";
}
export type Chat = ReturnType<typeof useChat>;
export const chatKey: InjectionKey<Chat> = Symbol("pulse-chat");
