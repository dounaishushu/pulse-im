import {
  computed,
  effectScope,
  onScopeDispose,
  shallowReactive,
  shallowRef,
  watch,
  type EffectScope,
  type ComputedRef,
  type InjectionKey,
} from "vue";
import {
  createClient,
  client as guest,
  request,
  messageOf,
  WEB_VERSION,
  type Client,
  type Config,
  type LoginResult,
} from "../api/client";
import type { Profile } from "../api/types";
import { useChat, type Chat } from "./useChat";
import { useOutbox, type TextOutbox } from "../features/chat/useOutbox";
import {
  createAccountVault,
  accountMetadata,
  type SavedAccount,
} from "../features/accounts/accountVault";

interface Runtime {
  key: string;
  client: Client;
  chat: Chat;
  outbox: TextOutbox;
  scope: EffectScope;
  foreground: ComputedRef<boolean>;
}
interface Entry {
  saved: SavedAccount;
  runtime?: Runtime;
  error?: string;
}
export function useSession() {
  const entries = shallowReactive(new Map<number, Entry>()),
    activeId = shallowRef(0),
    adding = shallowRef(false),
    accountsOpen = shallowRef(false),
    loading = shallowRef(true),
    busy = shallowRef(false),
    error = shallowRef(""),
    notice = shallowRef(""),
    config = shallowRef<Config | null>(null),
    locked = shallowRef(false);
  const vault = createAccountVault(guest.base),
    selectionKey = "pulse_web_active:" + guest.base;
  let alive = true,
    revision = 0,
    restoring: Promise<void> | undefined,
    restoreAgain = false;
  try {
    locked.value =
      JSON.parse(localStorage.getItem("pulse_lock_settings") || "{}")
        .enabled === true;
  } catch {}
  const signal = new AbortController();
  const channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("pulse-web-accounts:" + guest.base)
      : undefined;
  const current = computed(() => entries.get(activeId.value)?.runtime);
  const items = computed(() =>
    [...entries.values()].map((entry) => ({
      id: entry.saved.id,
      profile: entry.runtime?.chat.me.value || entry.saved.profile,
      active: entry.saved.id === activeId.value,
      unread: entry.runtime?.chat.totalUnread.value || 0,
      connected: entry.runtime?.chat.connected.value === true,
      expired: !entry.saved.token,
      error: entry.error || entry.runtime?.chat.issue.value || "",
    })),
  );
  const phase = computed(() =>
    loading.value
      ? "checking"
      : error.value && !adding.value
        ? "error"
        : adding.value || !current.value
          ? "login"
          : "workspace",
  );
  const title = computed(() => {
    const count = items.value.reduce((sum, item) => sum + item.unread, 0);
    return (count ? "(" + count + ") " : "") + "小猿答疑";
  });
  watch(
    title,
    (value) => {
      document.title = value;
    },
    { immediate: true },
  );
  function announce() {
    if (alive) channel?.postMessage({ type: "accounts.changed" });
  }
  function stop(entry: Entry) {
    entry.runtime?.scope.stop();
    entry.runtime?.client.session("");
  }
  function remember(id: number) {
    activeId.value = id;
    sessionStorage.setItem(selectionKey, String(id));
  }
  function selectAvailable() {
    const next = [...entries.values()].find(
      (entry) => entry.saved.token && entry.runtime,
    );
    remember(next?.saved.id || 0);
  }
  async function persist(saved: SavedAccount) {
    try {
      await vault.save(saved);
      announce();
      return true;
    } catch (cause) {
      notice.value =
        "当前浏览器未能保存账号，刷新后可能需要重新登录：" + messageOf(cause);
      return false;
    }
  }
  function makeEntry(saved: SavedAccount) {
    const entry = shallowReactive<Entry>({ saved });
    entries.set(saved.id, entry);
    if (!saved.token) return entry;
    if (saved.expiresAt && Date.parse(saved.expiresAt) <= Date.now()) {
      entry.saved = { ...saved, token: undefined };
      void vault
        .expire(saved.id, saved.revision)
        .then(announce)
        .catch(() => {});
      return entry;
    }
    const api = createClient();
    api.session(saved.token);
    const scope = effectScope(true),
      foreground = computed(
        () =>
          activeId.value === saved.id &&
          !adding.value &&
          !loading.value &&
          !error.value &&
          !locked.value,
      );
    const runtime = scope.run(() => {
      const chat = useChat(
        (cause) => {
          if (entries.get(saved.id) !== entry) return;
          entry.error = messageOf(cause);
          entries.set(saved.id, entry);
          if (activeId.value === saved.id) error.value = entry.error;
        },
        () => {
          void invalidate(saved.id, saved.revision);
        },
        api,
        {
          foreground,
          locked,
          logout: () => logout(saved.id),
          notifyOpen: (cid) => {
            activate(saved.id);
            void chat.choose(cid);
          },
        },
      );
      const outbox = useOutbox(chat);
      watch(chat.me, (profile) => {
        if (profile && entries.get(saved.id)?.runtime?.chat === chat) {
          const metadata = accountMetadata(profile);
          if (
            JSON.stringify(metadata) !== JSON.stringify(entry.saved.profile)
          ) {
            entry.saved = { ...entry.saved, profile: metadata };
            void vault
              .profile(saved.id, entry.saved.revision, metadata)
              .then(announce)
              .catch(() => {});
          }
        }
      });
      return {
        key: saved.revision,
        client: api,
        chat,
        outbox,
        scope,
        foreground,
      };
    })!;
    entry.runtime = runtime;
    entries.set(saved.id, entry);
    return entry;
  }
  async function initialize(entry: Entry) {
    entry.error = undefined;
    await entry.runtime?.chat.initialize();
    if (
      entry.runtime?.chat.me.value &&
      !entry.error &&
      notice.value.startsWith("登录已成功，资料暂时加载失败")
    )
      notice.value = "";
  }
  async function restore() {
    if (restoring) return restoring;
    restoring = (async () => {
      const saved = await vault.list();
      if (!alive) return;
      const byId = new Map(saved.map((account) => [account.id, account]));
      for (const [id, entry] of entries)
        if (!byId.has(id) || byId.get(id)!.revision !== entry.saved.revision) {
          stop(entry);
          entries.delete(id);
        }
      const added: Entry[] = [];
      for (const account of saved)
        if (!entries.has(account.id)) added.push(makeEntry(account));
      if (!entries.get(activeId.value)?.saved.token) {
        const remembered = Number(sessionStorage.getItem(selectionKey));
        if (entries.get(remembered)?.saved.token) remember(remembered);
        else selectAvailable();
      }
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(2, added.length) }, async () => {
          while (next < added.length && alive) {
            await initialize(added[next++]!);
          }
        }),
      );
    })()
      .catch((cause) => {
        notice.value = "账号恢复失败，可重新登录：" + messageOf(cause);
      })
      .finally(() => {
        restoring = undefined;
        if (restoreAgain && alive) {
          restoreAgain = false;
          void restore();
        }
      });
    return restoring;
  }
  async function enter() {
    const mine = ++revision;
    loading.value = true;
    error.value = "";
    try {
      config.value = await request<Config>("/client/config", { authToken: "" });
      const update = await guest.raw<{ required: boolean; notes?: string }>(
        "/client/update?platform=web&version=" + WEB_VERSION,
        { authToken: "", signal: signal.signal },
      );
      if (update.required)
        throw Error(update.notes || "网页版本需要更新，请刷新页面。");
      if (mine !== revision || !alive) return;
      await restore();
      // Adopt a valid session from the previous single-account Web only once.
      const oldToken = localStorage.getItem(guest.tokenKey);
      if (oldToken) {
        try {
          if (await accept({ access_token: oldToken, user_id: 0 }, false))
            localStorage.removeItem(guest.tokenKey);
        } catch (cause) {
          if ((cause as { status?: number }).status === 401)
            localStorage.removeItem(guest.tokenKey);
          else notice.value = "旧账号恢复暂时失败：" + messageOf(cause);
        }
      }
      if (!activeId.value) selectAvailable();
    } catch (cause) {
      if (alive && mine === revision) error.value = messageOf(cause);
    } finally {
      if (alive && mine === revision) loading.value = false;
    }
  }
  async function accept(result: LoginResult, activateNew = true) {
    const api = createClient();
    api.session(result.access_token);
    let profile: Profile;
    try {
      profile = await api.request<Profile>("/auth/me", {
        signal: AbortSignal.any([signal.signal, AbortSignal.timeout(20000)]),
      });
    } catch (cause) {
      if (
        (cause as { status?: number }).status === 401 ||
        !Number.isSafeInteger(result.user_id) ||
        result.user_id <= 0
      ) {
        api.session("");
        throw cause;
      }
      profile = {
        id: result.user_id,
        user_id: result.user_id,
        username: loginAccount.value,
        nickname: loginAccount.value || "新登录账号",
        avatar_url: "",
        public_id: "",
        signature: "",
      };
      notice.value = "登录已成功，资料暂时加载失败，正在保留会话并重试。";
    }
    if (!alive) return;
    if (result.user_id && profile.id !== result.user_id)
      throw Error("登录资料与账号不匹配，请重试。");
    const saved: SavedAccount = {
      id: profile.id,
      profile: accountMetadata(profile),
      token: result.access_token,
      expiresAt: result.expires_at,
      revision: crypto.randomUUID(),
    };
    const written = await persist(saved);
    const previous = entries.get(saved.id);
    if (previous) stop(previous);
    const entry = makeEntry(saved);
    adding.value = false;
    error.value = "";
    accountsOpen.value = false;
    if (activateNew || !activeId.value) remember(saved.id);
    api.session("");
    await initialize(entry);
    return written;
  }
  async function authenticated(result: LoginResult) {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      await accept(result);
    } catch (cause) {
      error.value = messageOf(cause);
    } finally {
      busy.value = false;
    }
  }
  function activate(id: number) {
    const entry = entries.get(id);
    if (!entry) return;
    if (!entry.saved.token) {
      addAccount(id);
      return;
    }
    remember(id);
    adding.value = false;
    accountsOpen.value = false;
    error.value = "";
    if (entry.error) {
      entry.error = "";
      void initialize(entry);
    }
  }
  const loginAccount = shallowRef("");
  function addAccount(id?: number) {
    if (locked.value || busy.value) return;
    loginAccount.value = id
      ? entries.get(id)?.saved.profile.username || ""
      : "";
    adding.value = true;
    accountsOpen.value = false;
    error.value = "";
  }
  function cancelAdd() {
    adding.value = false;
    error.value = "";
    if (!current.value) selectAvailable();
  }
  async function invalidate(id: number, expected: string) {
    const entry = entries.get(id);
    if (!entry || entry.saved.revision !== expected) return;
    stop(entry);
    entry.runtime = undefined;
    entry.saved = { ...entry.saved, token: undefined };
    entries.set(id, entry);
    if (activeId.value === id) {
      error.value = "";
      selectAvailable();
      notice.value = "一个账号的登录已失效，请在账号列表中重新登录。";
    }
    try {
      const next = await vault.expire(id, expected);
      if (next) entry.saved = { ...entry.saved, revision: next };
      else void restore();
      announce();
    } catch {}
  }
  async function logout(id = activeId.value) {
    const entry = entries.get(id);
    if (!entry || busy.value) return;
    busy.value = true;
    try {
      if (entry.runtime && entry.saved.token)
        try {
          await entry.runtime.client.request("/auth/logout", {
            method: "POST",
            signal: AbortSignal.timeout(12000),
          });
        } catch (cause) {
          if ((cause as { status?: number }).status !== 401) throw cause;
        }
      const removed = await vault.remove(id, entry.saved.revision);
      if (!removed) {
        await restore();
        return;
      }
      if (entries.get(id) !== entry) return;
      stop(entry);
      entries.delete(id);
      announce();
      if (activeId.value === id) {
        error.value = "";
        selectAvailable();
      }
    } catch (cause) {
      notice.value = "退出未完成：" + messageOf(cause);
    } finally {
      busy.value = false;
    }
  }
  function failed(cause: unknown) {
    error.value = messageOf(cause);
  }
  function retry() {
    error.value = "";
    const entry = entries.get(activeId.value);
    if (entry) void initialize(entry);
    else void enter();
  }
  const changed = () => {
    if (restoring) {
      restoreAgain = true;
      return;
    }
    void restore();
  };
  channel?.addEventListener("message", changed);
  window.addEventListener("focus", changed, { signal: signal.signal });
  onScopeDispose(() => {
    alive = false;
    signal.abort();
    revision++;
    channel?.close();
    for (const entry of entries.values()) stop(entry);
    document.title = "小猿答疑";
  });
  return {
    phase,
    error,
    notice,
    config,
    items,
    current,
    activeId,
    adding,
    accountsOpen,
    loading,
    busy,
    locked,
    loginAccount,
    enter,
    authenticated,
    activate,
    addAccount,
    cancelAdd,
    logout,
    failed,
    retry,
  };
}
export type Accounts = ReturnType<typeof useSession>;
export const accountsKey: InjectionKey<Accounts> = Symbol("web-accounts");
