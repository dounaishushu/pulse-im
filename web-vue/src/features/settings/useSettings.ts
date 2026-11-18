import {
  computed,
  toRaw,
  inject,
  onScopeDispose,
  reactive,
  shallowRef,
  type InjectionKey,
} from "vue";
import { chatKey } from "../../composables/useChat";
import { client, messageOf } from "../../api/client";
import type { LoginSession, Page, Profile } from "../../api/types";
export function useSettings(emit: (event: "close") => void) {
  const chat = inject(chatKey)!;
  const globalThis = window,
    Notification = window.Notification,
    location = window.location,
    localStorage = window.localStorage;
  type Section =
    | "home"
    | "profile"
    | "notifications"
    | "privacy"
    | "chat"
    | "media"
    | "advanced"
    | "language"
    | "sessions"
    | "blocked"
    | "password"
    | "security"
    | "lock"
    | "help";
  const section = shallowRef<Section>("home"),
    busy = shallowRef(false),
    loading = shallowRef(false),
    loadError = shallowRef(""),
    feedback = shallowRef("");
  const titles: Record<Section, string> = {
    home: "设置",
    profile: "个人信息",
    notifications: "通知",
    privacy: "隐私和安全",
    chat: "对话设置",
    media: "通话设置",
    advanced: "高级",
    language: "语言",
    sessions: "活跃会话",
    blocked: "已屏蔽的用户",
    password: "修改登录密码",
    security: "两步验证",
    lock: "本机锁定码",
    help: "帮助",
  };
  const profile = reactive({
    nickname: chat.me.value?.nickname || "",
    username: chat.me.value?.username || "",
    birthday: chat.me.value?.birthday || "",
    gender: chat.me.value?.gender || "",
    signature: chat.me.value?.signature || "",
  });
  const privacy = shallowRef<Record<string, unknown>>({}),
    exceptions = reactive<Record<string, string>>({}),
    contacts = shallowRef<Profile[]>([]);
  interface PrivacyRule {
    visibility: string;
    allow: string[];
    deny: string[];
  }
  const rulesExtra = reactive<Record<string, PrivacyRule>>({
    temporary_chat: { visibility: "everyone", allow: [], deny: [] },
    group_invites: { visibility: "everyone", allow: [], deny: [] },
  });
  const extraNames = reactive<Record<string, { allow: string; deny: string }>>({
    temporary_chat: { allow: "", deny: "" },
    group_invites: { allow: "", deny: "" },
  });
  const rawPrivacy = reactive<Record<string, unknown>>({});
  const sessions = shallowRef<LoginSession[]>([]),
    blocks = shallowRef<
      { blocked_id: number; nickname: string; reason?: string }[]
    >([]),
    security = shallowRef<{ enabled?: boolean; recovery_codes?: string[] }>({});
  const oldPassword = shallowRef(""),
    newPassword = shallowRef(""),
    confirmPassword = shallowRef(""),
    currentCode = shallowRef(""),
    newCode = shallowRef("");
  const lockCurrent = shallowRef(""),
    lockNext = shallowRef(""),
    lockConfirm = shallowRef("");
  const devices = shallowRef<MediaDeviceInfo[]>([]),
    micActive = shallowRef(false),
    meter = shallowRef(0),
    volume = shallowRef(
      Number(localStorage.getItem("pulse_output_volume") || 100),
    ),
    inputVolume = shallowRef(
      Number(localStorage.getItem("pulse_input_volume") || 100),
    ),
    inputDevice = shallowRef(
      localStorage.getItem("pulse_audio_input") || "default",
    ),
    outputDevice = shallowRef(
      localStorage.getItem("pulse_audio_output") || "default",
    );
  const scale = shallowRef(
      Number(localStorage.getItem("pulse_interface_scale") || 1),
    ),
    theme = shallowRef(localStorage.getItem("pulse_chat_theme") || "classic"),
    language = shallowRef(localStorage.getItem("pulse_language") || "zh-CN");
  const notificationCount = shallowRef(
    Math.max(
      1,
      Math.min(
        5,
        Number(localStorage.getItem("pulse_notification_count") || 3),
      ),
    ),
  );
  function saveNotificationCount() {
    localStorage.setItem(
      "pulse_notification_count",
      String(notificationCount.value),
    );
    window.dispatchEvent(new Event("pulse:preferences"));
  }
  const local = reactive<Record<string, boolean>>({});
  const toggles = {
    notifications: [
      ["notify_enabled", "启用通知", true],
      ["notify_sender", "显示发送者昵称", true],
      ["notify_preview", "显示消息预览", true],
      ["notify_sound", "播放提示音", true],
      ["unread_include_muted", "包含已关闭通知的对话", true],
      ["unread_message_count", "按消息数统计未读", true],
    ],
    chat: [
      ["large_emoji", "大号 Emoji", true],
      ["emoji_replace", "替换字符表情为 emoji", true],
      ["emoji_suggest", "根据 emoji 联想表情", true],
      ["emoji_popular", "通过 emoji 推荐热门表情", true],
      ["animated_stickers", "循环播放动画贴纸", true],
      ["background_tile", "平铺背景", false],
      ["send_ctrl_enter", "按 Ctrl+Enter 发送", false],
    ],
    advanced: [
      ["animations", "动画切换效果", true],
      ["animated_gif", "自动播放 GIF", true],
      ["spellcheck", "使用系统拼写检查器", true],
    ],
  } as const;
  for (const list of Object.values(toggles))
    for (const [key, , fallback] of list)
      local[key] =
        localStorage.getItem("pulse_setting_" + key) === null
          ? fallback
          : localStorage.getItem("pulse_setting_" + key) === "1";
  const rules = [
    ["phone_visibility", "手机号码"],
    ["phone_search_visibility", "通过手机搜索"],
    ["last_seen_visibility", "最后上线时间"],
    ["voice_call_visibility", "语音通话"],
    ["invite_visibility", "邀请权限控制"],
  ] as const;
  const exceptionRules = [
    ["phone_visibility_always", "手机号码：始终允许"],
    ["phone_search_always", "手机号搜索：始终允许"],
    ["last_seen_never", "最近上线：永不允许"],
    ["voice_call_never", "语音通话：永不允许"],
    ["invite_never", "群邀请：永不允许"],
  ] as const;
  const downloads = reactive<Record<string, boolean>>({});
  const limits = reactive<Record<string, number>>({});
  for (const scope of ["private", "group", "channel"]) {
    limits[scope] = Number(
      localStorage.getItem("pulse_media_download_" + scope + "_max_mb") || 50,
    );
    for (const category of ["photos", "videos", "files"])
      downloads[scope + "_" + category] =
        (localStorage.getItem(
          "pulse_setting_media_download_" + scope + "_" + category,
        ) ?? localStorage.getItem("pulse_setting_auto_download_" + scope)) !==
        "0";
  }
  const mediaOutputs = computed(() =>
      devices.value.filter((value) => value.kind === "audiooutput"),
    ),
    mediaInputs = computed(() =>
      devices.value.filter((value) => value.kind === "audioinput"),
    );
  let disposed = false,
    stream: MediaStream | undefined,
    audio: AudioContext | undefined,
    frame = 0;
  let openRevision = 0,
    openController = new AbortController();
  async function open(next: Section) {
    if (next !== "media") stopMic();
    openController.abort();
    openController = new AbortController();
    const mine = ++openRevision;
    const signal = AbortSignal.any([
        openController.signal,
        AbortSignal.timeout(20000),
      ]),
      current = () => !disposed && mine === openRevision;
    loadError.value = "";
    section.value = next;
    feedback.value = "";
    loading.value = true;
    try {
      if (next === "privacy") {
        const [settings, people, raw] = await Promise.all([
          chat.api<Record<string, unknown>>("/auth/settings", { signal }),
          chat.api<Page<Profile>>("/contacts?size=100", { signal }),
          chat.api<Record<string, unknown>>("/go/privacy", { signal }),
        ]);
        if (!current()) return;
        privacy.value = settings;
        contacts.value = people.items;
        Object.assign(rawPrivacy, raw);
        const values =
          (privacy.value.privacy_exceptions as Record<string, number[]>) || {};
        for (const [key] of exceptionRules)
          exceptions[key] = (values[key] || [])
            .map(
              (id) =>
                contacts.value.find((user) => user.id === id)?.username ||
                String(id),
            )
            .join("\n");
        const users =
          (raw.exception_users as { id: string; account: string }[]) || [];
        for (const key of ["temporary_chat", "group_invites"]) {
          rulesExtra[key] = structuredClone(raw[key] as PrivacyRule);
          for (const list of ["allow", "deny"] as const)
            extraNames[key]![list] = rulesExtra[key]![list].map(
              (id) => users.find((user) => user.id === id)?.account || id,
            ).join("\n");
        }
      }
      if (next === "sessions") {
        const result = await chat.api<Page<LoginSession>>("/auth/sessions", {
          signal,
        });
        if (current()) sessions.value = result.items;
      }
      if (next === "blocked") {
        const result = await chat.api<Page<(typeof blocks.value)[number]>>(
          "/blocks",
          { signal },
        );
        if (current()) blocks.value = result.items;
      }
      if (next === "security") {
        const result = await chat.api<typeof security.value>("/auth/security", {
          signal,
        });
        if (current()) security.value = result;
      }
      if (next === "media" && navigator.mediaDevices) {
        const result = await navigator.mediaDevices.enumerateDevices();
        if (current()) devices.value = result;
      }
    } catch (cause) {
      if (current() && !openController.signal.aborted) {
        loadError.value = messageOf(cause);
        if ((cause as { status?: number }).status === 401) chat.error(cause);
      }
    } finally {
      if (current()) loading.value = false;
    }
  }
  function toggle(key: string, value: boolean) {
    local[key] = value;
    localStorage.setItem("pulse_setting_" + key, value ? "1" : "0");
    window.dispatchEvent(new Event("pulse:preferences"));
  }
  async function task(action: () => Promise<unknown>) {
    if (busy.value || loading.value || loadError.value) return;
    busy.value = true;
    feedback.value = "";
    try {
      await action();
      if (!disposed) feedback.value = "已保存";
    } catch (cause) {
      chat.error(cause);
    } finally {
      busy.value = false;
    }
  }
  async function saveProfile() {
    await task(async () => {
      const current = chat.me.value!;
      const patch: Record<string, unknown> = {
        nickname: profile.nickname,
        gender: profile.gender,
        signature: profile.signature,
      };
      if (!current.username && profile.username)
        patch.username = profile.username;
      if (
        !current.birthday_change_count &&
        profile.birthday &&
        profile.birthday !== current.birthday
      ) {
        if (!confirm("生日只能修改一次，确认保存？")) return;
        patch.birthday = profile.birthday;
      }
      chat.me.value = await chat.post<Profile>("/auth/profile", patch);
      await chat.loadDirectory();
    });
  }
  async function avatar(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    await task(async () => {
      const result = await client.uploadMedia("avatar", file);
      chat.me.value = await chat.post<Profile>("/auth/profile", {
        avatar_url: result.url,
      });
    });
  }
  async function savePrivacy() {
    await task(async () => {
      const body: Record<string, unknown> = {
        ...privacy.value,
        privacy_exceptions: {},
      };
      if (privacy.value.can_manage_privacy === false)
        delete body.invite_visibility;
      for (const [key] of exceptionRules) {
        if (
          key === "invite_never" &&
          privacy.value.can_manage_privacy === false
        )
          continue;
        const ids: number[] = [];
        for (const name of (exceptions[key] || "")
          .split(/\n/)
          .map((item) => item.trim())
          .filter(Boolean)) {
          const known = contacts.value.find(
            (user) => user.username === name || String(user.id) === name,
          );
          if (known) ids.push(known.id);
          else {
            const found = await chat.api<Page<Profile>>(
              "/contacts/search?q=" + encodeURIComponent(name),
            );
            if (found.items.length !== 1) throw Error("找不到账号：" + name);
            ids.push(found.items[0]!.id);
          }
        }
        (body.privacy_exceptions as Record<string, number[]>)[key] = ids;
      }
      privacy.value = await chat.post("/auth/settings", { settings: body });
    });
  }
  async function password() {
    if (newPassword.value !== confirmPassword.value) {
      feedback.value = "两次新密码不同";
      return;
    }
    await task(async () => {
      await chat.post("/auth/password", {
        current_password: oldPassword.value,
        new_password: newPassword.value,
      });
      oldPassword.value = "";
      newPassword.value = "";
      confirmPassword.value = "";
      localStorage.removeItem(client.tokenKey);
      location.reload();
    });
  }
  async function twoStep(action: string) {
    await task(async () => {
      security.value = await chat.post("/auth/security", {
        action: action === "rotate-recovery" ? "recovery" : action,
        login_password: oldPassword.value,
        current: currentCode.value,
        next: newCode.value,
      });
      oldPassword.value = "";
      currentCode.value = "";
      newCode.value = "";
    });
  }
  async function digest(value: string) {
    return [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  async function lockCode(disable = false) {
    await task(async () => {
      let saved: { enabled?: boolean; hash?: string } = {};
      try {
        saved = JSON.parse(localStorage.getItem("pulse_lock_settings") || "{}");
      } catch {}
      if (saved.enabled && (await digest(lockCurrent.value)) !== saved.hash)
        throw Error("当前锁定码错误");
      if (disable) localStorage.removeItem("pulse_lock_settings");
      else {
        if (
          !/^\d{4,12}$/.test(lockNext.value) ||
          lockNext.value !== lockConfirm.value
        )
          throw Error("请输入两次相同的 4–12 位数字锁定码");
        localStorage.setItem(
          "pulse_lock_settings",
          JSON.stringify({
            enabled: true,
            hash: await digest(lockNext.value),
            locked: false,
          }),
        );
      }
      lockCurrent.value = "";
      lockNext.value = "";
      lockConfirm.value = "";
    });
  }
  function setTheme() {
    localStorage.setItem("pulse_chat_theme", theme.value);
    document.body.dataset.theme = theme.value;
    document.documentElement.style.colorScheme =
      theme.value === "night" ? "dark" : "light";
    document.documentElement.dataset.colorMode =
      theme.value === "night" ? "night" : "day";
    if (theme.value !== "night")
      localStorage.setItem("pulse_chat_light_theme", theme.value);
    localStorage.setItem(
      "pulse_night_mode",
      theme.value === "night" ? "1" : "0",
    );
    window.dispatchEvent(new Event("pulse:preferences"));
    document.body.classList.toggle(
      "desktop-night-mode",
      theme.value === "night",
    );
  }
  function setScale() {
    localStorage.setItem("pulse_interface_scale", String(scale.value));
    document.documentElement.style.zoom = String(scale.value);
  }
  async function background(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) {
      feedback.value = "背景请选择小于 2MB 的图片";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      localStorage.setItem("pulse_vue_background", value);
      window.dispatchEvent(new Event("pulse:preferences"));
    };
    reader.readAsDataURL(file);
  }
  function saveDownloads() {
    for (const scope of ["private", "group", "channel"]) {
      localStorage.setItem(
        "pulse_media_download_" + scope + "_max_mb",
        String(limits[scope]),
      );
      for (const category of ["photos", "videos", "files"])
        localStorage.setItem(
          "pulse_setting_media_download_" + scope + "_" + category,
          downloads[scope + "_" + category] ? "1" : "0",
        );
    }
    window.dispatchEvent(new Event("pulse:preferences"));
  }
  function saveAudio() {
    localStorage.setItem("pulse_output_volume", String(volume.value));
    localStorage.setItem("pulse_input_volume", String(inputVolume.value));
    localStorage.setItem("pulse_audio_output", outputDevice.value);
    localStorage.setItem("pulse_audio_input", inputDevice.value);
    window.dispatchEvent(new Event("pulse:preferences"));
  }
  async function saveExtra() {
    await task(async () => {
      const patch: Record<string, unknown> = {
        expected_version: rawPrivacy.version,
      };
      for (const key of [
        "temporary_chat",
        ...(rawPrivacy.can_manage_group_invites ? ["group_invites"] : []),
      ]) {
        const rule = structuredClone(toRaw(rulesExtra[key]!));
        for (const list of ["allow", "deny"] as const) {
          rule[list] = [];
          for (const name of extraNames[key]![list].split(/\n/)
            .map((value) => value.trim())
            .filter(Boolean)) {
            const existing = (
              (rawPrivacy.exception_users as {
                id: string;
                account: string;
              }[]) || []
            ).find((user) => user.account === name || user.id === name);
            if (existing) rule[list].push(existing.id);
            else {
              const result = await chat.api<Page<Profile>>(
                "/contacts/search?q=" + encodeURIComponent(name),
              );
              if (result.items.length !== 1) throw Error("找不到账号：" + name);
              rule[list].push(client.wire("user", result.items[0]!.id));
            }
          }
        }
        patch[key] = rule;
      }
      await chat.api("/go/privacy", { method: "PATCH", body: patch });
      await open("privacy");
    });
  }
  function stopMic() {
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach((track) => track.stop());
    void audio?.close();
    stream = undefined;
    audio = undefined;
    micActive.value = false;
    meter.value = 0;
  }
  async function testMic() {
    if (micActive.value) {
      stopMic();
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio:
          inputDevice.value === "default"
            ? true
            : { deviceId: { exact: inputDevice.value } },
      });
      if (disposed) {
        stopMic();
        return;
      }
      audio = new AudioContext();
      const analyser = audio.createAnalyser();
      const gain = audio.createGain();
      gain.gain.value = inputVolume.value / 100;
      audio.createMediaStreamSource(stream).connect(gain);
      gain.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      micActive.value = true;
      function tick() {
        analyser.getByteFrequencyData(data);
        meter.value = Math.round(
          (data.reduce((a, b) => a + b, 0) / data.length / 255) * 100,
        );
        frame = requestAnimationFrame(tick);
      }
      tick();
      devices.value = await navigator.mediaDevices.enumerateDevices();
    } catch (cause) {
      chat.error(cause);
      stopMic();
    }
  }
  function exportData() {
    const data = {
      profile: {
        nickname: chat.me.value?.nickname,
        public_id: chat.me.value?.public_id,
      },
      exported_at: new Date().toISOString(),
      settings: Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) =>
            /^pulse_(?:setting_|media_download_|chat_|night_mode|language|audio_|input_volume|output_volume|interface_scale|sidebar_width|recent_emojis|notification_count|vue_background)/.test(
              key,
            ),
          )
          .map((key) => [key, localStorage.getItem(key)]),
      ),
      preferences: {
        theme: theme.value,
        scale: scale.value,
        language: language.value,
        ...local,
      },
      messages: chat.messages.value,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "小猿答疑-导出.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function clearCache() {
    if (window.caches)
      for (const key of await caches.keys()) await caches.delete(key);
    for (const key of Object.keys(localStorage))
      if (/^pulse_vue_(?:media|cache)/.test(key)) localStorage.removeItem(key);
    feedback.value = "应用缓存已清理，浏览器网络缓存可在网站设置中清理";
  }
  onScopeDispose(() => {
    disposed = true;
    openRevision++;
    openController.abort();
    stopMic();
    oldPassword.value = "";
    newPassword.value = "";
    currentCode.value = "";
    newCode.value = "";
  });

  return {
    emit,
    chat,
    globalThis,
    Notification,
    location,
    localStorage,
    section,
    busy,
    loading,
    loadError,
    feedback,
    titles,
    profile,
    privacy,
    exceptions,
    contacts,
    rulesExtra,
    extraNames,
    rawPrivacy,
    sessions,
    blocks,
    security,
    oldPassword,
    newPassword,
    confirmPassword,
    currentCode,
    newCode,
    lockCurrent,
    lockNext,
    lockConfirm,
    devices,
    micActive,
    meter,
    volume,
    inputVolume,
    inputDevice,
    outputDevice,
    scale,
    theme,
    language,
    notificationCount,
    saveNotificationCount,
    local,
    toggles,
    rules,
    exceptionRules,
    downloads,
    limits,
    mediaOutputs,
    mediaInputs,
    open,
    toggle,
    task,
    saveProfile,
    avatar,
    savePrivacy,
    password,
    twoStep,
    digest,
    lockCode,
    setTheme,
    setScale,
    background,
    saveDownloads,
    saveAudio,
    saveExtra,
    stopMic,
    testMic,
    exportData,
    clearCache,
  };
}
export type Settings = ReturnType<typeof useSettings>;
export const settingsKey: InjectionKey<Settings> = Symbol("settings");
export function useSettingsContext() {
  const settings = inject(settingsKey);
  if (!settings) throw Error("Settings context missing");
  return settings;
}
