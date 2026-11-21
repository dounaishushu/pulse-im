import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { desktopSessionLease, archiveWindow, chatWindows, desktopArchive } from "./archive";
import { desktopScreenshot, screenshotOverlay } from "./screenshot";
import { chatTypography } from "./typography";
import { desktopExplorerFiles, prepareExplorerUpload } from "./explorer";
import type { ClientPlatform, DesktopDiagnosticEvent, DesktopRouteDirectory, DesktopWindowKind, NoticeClick, PreparedUpload, RealtimeSocket, TrayAccountAction, UploadAttachment } from "../../web-vue/src/platform/contracts";

interface DesktopInfo {
  apiBase: string;
  routeBase: string;
  mediaOrigins: string[];
  windowKind: DesktopWindowKind;
  version: string;
}

type SocketEvent = { type: "open" } | { type: "message"; data: string } | { type: "closed" };
let info: DesktopInfo;
let mediaOrigins = new Set<string>();
function applyRoute(directory: DesktopRouteDirectory) {
  const changed = info.routeBase !== directory.base;
  info.routeBase = directory.base;
  mediaOrigins = new Set(directory.origins);
  if (changed) window.dispatchEvent(new Event("pulse:desktop-route"));
  return directory;
}
function mediaSource(input: string): string {
  if (!input) return "";
  try {
    const url = new URL(input, location.origin);
    if (url.origin === location.origin && !/^\/api\//.test(url.pathname)) return url.href;
    if (url.protocol === "blob:" && url.origin === location.origin) return url.href;
    if (url.origin === "https://pulsemedia.localhost") return url.href;
    const isGrant = /^\/api\/v2\/media-grants\/[a-f0-9]{64}\/(content|preview)$/.test(url.pathname);
    if (!isGrant || !mediaOrigins.has(url.origin) || url.username || url.password || url.search || url.hash) return "";
    return `https://pulsemedia.localhost/${encodeURIComponent(url.origin)}${url.pathname}`;
  } catch {
    return "";
  }
}
const lastDiagnostic = new Map<DesktopDiagnosticEvent, number>();

function reportDiagnostic(event: DesktopDiagnosticEvent, durationMs?: number) {
  if (!info || !["workspace", "conversation"].includes(info.windowKind)) return;
  const now = performance.now();
  const last = lastDiagnostic.get(event);
  if (last !== undefined && now - last < 5_000) return;
  lastDiagnostic.set(event, now);
  void invoke("report_desktop_diagnostic", { event, durationMs }).catch(() => {});
}

class DesktopSocket implements RealtimeSocket {
  readyState = 0;
  onmessage: RealtimeSocket["onmessage"] = null;
  onerror: RealtimeSocket["onerror"] = null;
  onclose: RealtimeSocket["onclose"] = null;
  private readonly connectionId = crypto.randomUUID();
  private readonly events = new Channel<SocketEvent>();
  private readonly registration: Promise<void>;

  constructor(url: string) {
    const target = new URL(url);
    const expected = new URL(info.routeBase.replace(/^http/, "ws") + "/realtime");
    if (target.origin !== expected.origin || target.pathname !== expected.pathname)
      throw Error("invalid_realtime_origin");
    this.events.onmessage = (event) => {
      if (event.type === "closed") {
        this.finished();
      } else if (this.readyState < 2) {
        if (event.type === "open") this.readyState = 1;
        else this.onmessage?.({ data: event.data });
      }
    };
    this.registration = invoke<void>("realtime_connect", {
      connectionId: this.connectionId,
      origin: target.origin,
      ticket: target.searchParams.get("ticket"),
      events: this.events,
    });
    void this.registration.catch(() => {
      this.onerror?.();
      this.finished();
    });
  }

  private finished() {
    if (this.readyState === 3) return;
    if (this.readyState !== 2) reportDiagnostic("realtimeDisconnected");
    this.readyState = 3;
    this.onclose?.();
    this.onmessage = this.onerror = this.onclose = null;
  }

  send(text: string) {
    if (this.readyState !== 1) return;
    void invoke("realtime_send", { connectionId: this.connectionId, text }).catch(() => this.close());
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    void this.registration.then(() => invoke("realtime_disconnect", {
      connectionId: this.connectionId,
    })).catch(() => this.finished());
  }
}

interface ApiReply {
  status: number;
  contentType?: string;
  retryAfter?: string;
  url: string;
  body: string;
}

class DesktopConnectionError extends TypeError {
  readonly code = "desktop_transport_unavailable";

  constructor() {
    super("连接暂时中断，请稍后重试。");
  }
}

async function nativeFetchOnce(input: RequestInfo | URL, init?: RequestInit, stageId?: string) {
  const request = new Request(input, init);
  const { signal } = request;
  signal.throwIfAborted();
  const body = request.body
    ? new Uint8Array(await request.arrayBuffer())
    : new Uint8Array();
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  const abort = () => { void invoke("api_cancel", { requestId }).catch(() => {}); };
  try {
    await invoke("api_start", {
      requestId,
      spec: {
        url: request.url,
        method: request.method,
        authorization: request.headers.get("Authorization"),
        contentType: request.headers.get("Content-Type"),
      },
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      signal.throwIfAborted();
    }
    const result = stageId
      ? await invoke<ApiReply>("api_execute_upload", { requestId, stageId })
      : await invoke<ApiReply>("api_execute", body, {
          headers: { "x-pulse-request-id": requestId },
        });
    signal.throwIfAborted();
    const headers = new Headers();
    if (result.contentType) headers.set("Content-Type", result.contentType);
    if (result.retryAfter) headers.set("Retry-After", result.retryAfter);
    const response = new Response([204, 205, 304].includes(result.status) ? null : result.body, {
      status: result.status,
      headers,
    });
    Object.defineProperty(response, "url", { value: result.url });
    return response;
  } catch (cause) {
    signal.throwIfAborted();
    // Native command failures use string codes. Match the browser fetch contract
    // so the same queue treats a transient connection failure as retryable.
    if (cause === "api_unavailable") {
      reportDiagnostic("httpUnavailable");
      throw new DesktopConnectionError();
    }
    if (cause === "api_busy") {
      reportDiagnostic("httpBusy");
      throw new TypeError("网络请求较多，请稍后重试。");
    }
    throw cause;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = init?.method || (input instanceof Request ? input.method : "GET");
  const isRead = method === "GET";
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const attemptedBase = info.routeBase;
  const recover = async () => {
    if (signal?.aborted) return false;
    const recovered = await invoke<DesktopRouteDirectory | null>("recover_desktop_route", { failedBase: attemptedBase }).catch(() => null);
    if (!recovered) return false;
    applyRoute(recovered);
    return true;
  };
  let response: Response;
  try {
    response = await nativeFetchOnce(input, init);
  } catch (cause) {
    if (!(cause instanceof DesktopConnectionError)) throw cause;
    if (!isRead) {
      void recover();
      throw cause;
    }
    if (!await recover()) throw cause;
    signal?.throwIfAborted();
    return nativeFetchOnce(input, init);
  }
  const unavailable = [502, 503, 504].includes(response.status) && !response.headers.has("Retry-After");
  if (unavailable && !isRead) void recover();
  if (unavailable && isRead && await recover()) {
    signal?.throwIfAborted();
    await response.body?.cancel();
    return nativeFetchOnce(input, init);
  }
  return response;
}

function stagedUpload(id: string, sha256: string): PreparedUpload {
  return {
    sha256,
    send: (url, options) => nativeFetchOnce(url, options, id),
    release: () => invoke<void>("release_upload_stage", { id }).catch(() => {}),
  };
}

async function prepareUpload(file: UploadAttachment, token: string, signal?: AbortSignal): Promise<PreparedUpload> {
  signal?.throwIfAborted();
  if ("source" in file) {
    const { id, sha256 } = await prepareExplorerUpload(file.id, token);
    const stage = stagedUpload(id, sha256);
    if (signal?.aborted) {
      await stage.release();
      signal.throwIfAborted();
    }
    return stage;
  }
  const id = await invoke<string>("create_upload_stage", { size: file.size, token });
  const release = () => invoke<void>("release_upload_stage", { id }).catch(() => {});
  const chunkSize = 512 * 1024;
  try {
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      signal?.throwIfAborted();
      const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
      signal?.throwIfAborted();
      await invoke("push_upload_stage", chunk, { headers: { "x-pulse-upload-stage": id } });
    }
    signal?.throwIfAborted();
    const sha256 = await invoke<string>("seal_upload_stage", { id });
    signal?.throwIfAborted();
    return stagedUpload(id, sha256);
  } catch (cause) {
    await release();
    signal?.throwIfAborted();
    throw new Error(typeof cause === "string" && cause === "upload_stage_busy"
      ? "待发送的文件较多，请稍后重试。"
      : "无法准备此附件，请检查磁盘空间后重试。");
  }
}

const desktop: ClientPlatform = {
  name: "pc",
  resolveApiBase: () => info.routeBase,
  mediaSource,
  routes: {
    list: (refresh = false) => invoke<DesktopRouteDirectory>("desktop_routes", { refresh, restore: false }).then(applyRoute),
    probe: (id) => invoke<DesktopRouteDirectory>("probe_desktop_route", { id }).then(applyRoute),
    select: (id) => invoke<DesktopRouteDirectory>("select_desktop_route", { id }).then(applyRoute),
  },
  network: {
    read: () => invoke("desktop_network_settings"),
    save: (preferences, revision) => invoke("set_desktop_network_settings", { preferences, revision }),
    test: (preferences, id) => invoke("test_desktop_network_settings", { preferences, id }),
    cancelTest: (id) => invoke("cancel_desktop_network_probe", { id }),
    async checkExit(token, provider) {
      const lease = await desktopSessionLease(token);
      return invoke("desktop_network_exit", { lease, provider });
    },
  },
  prepareUpload,
  archive: desktopArchive,
  chatTypography,
  screenshot: desktopScreenshot,
  screenshotOverlay,
  chatWindows,
  clearResourceCache: async (token) => invoke("clear_desktop_cache", { lease: await desktopSessionLease(token) }),
  archiveWindow,
  workspaces: {
    list: () => invoke("list_workspace_groups"),
    importLegacy: () => invoke("import_legacy_workspace_groups"),
    open: (group) => invoke("open_workspace_group", { group }),
    primary: () => invoke("focus_primary_workspace"),
  },
  updates: {
    check: (manual = false) => invoke("check_desktop_update", { manual }),
    openDownload: (expectedVersion) => invoke("open_desktop_update", { expectedVersion }),
  },
  diagnostics: {
    report: reportDiagnostic,
    openLogs: () => invoke("open_desktop_logs"),
  },
  trayAccounts: {
    sync: (rows, locked) => invoke("sync_tray_accounts", { rows, locked }),
    subscribe: (callback) => getCurrentWebviewWindow().listen<TrayAccountAction>(
      "pulse-tray-account-action", ({ payload }) => callback(payload),
    ),
  },
  signIns: {
    list: () => invoke("remembered_signins"),
    read: (id) => invoke("read_remembered_signin", { id }),
    save: (signIn) => invoke("remember_signin", { signIn }),
    forget: (id) => invoke("forget_remembered_signin", { id }),
  },
  get windowKind() { return info.windowKind; },
  notifications: {
    show: (input) => invoke("show_desktop_notice", { input }),
    clear: (scope) => invoke("clear_desktop_notices", { scope }),
    subscribe: (callback) => getCurrentWebviewWindow().listen<NoticeClick>(
      "pulse-desktop-notice-click", (event) => callback(event.payload),
    ),
  },
  noticeWindow: {
    snapshot: () => invoke("desktop_notices_snapshot"),
    ready: () => invoke("desktop_notices_ready"),
    subscribe: (listener) => listen("pulse-desktop-notices", listener),
    act: (id, action) => invoke("desktop_notice_action", { id, action }),
  },
  system: {
    openSoundSettings: () => invoke("open_system_sound_settings"),
    read: () => invoke("desktop_system_options"),
    set: (key, enabled) => invoke("set_desktop_system_option", { key, enabled }),
  },
  explorerFiles: desktopExplorerFiles,
  downloads: {
    preferences: async (token) => invoke("download_preferences", { lease: await desktopSessionLease(token) }),
    chooseDirectory: async (token, legacy) => invoke("choose_download_directory", { lease: await desktopSessionLease(token), legacy }),
    setAskBeforeDownload: async (token, enabled) => invoke("set_download_prompt", { lease: await desktopSessionLease(token), enabled }),
    start: async ({ token, ...input }) => invoke("start_download", { lease: await desktopSessionLease(token), input }),
    list: (token) => invoke("list_downloads", { token }),
    cancel: (id, token) => invoke("cancel_download", { id, token }),
    release: (token) => invoke("cancel_account_downloads", { token }),
  },
  get apiBase() { return info.apiBase; },
  get version() { return info.version; },
  async initialize() {
    info = await invoke<DesktopInfo>("desktop_info");
    mediaOrigins = new Set(info.mediaOrigins);
    if (!["workspace", "conversation", "history", "image"].includes(info.windowKind)) return;
    const view = getCurrentWebviewWindow();
    await view.listen<DesktopRouteDirectory>("pulse-desktop-route", ({ payload }) => { applyRoute(payload); });
    if (info.windowKind === "workspace") {
      void invoke<DesktopRouteDirectory>("desktop_routes", { refresh: false, restore: true })
        .then(applyRoute).catch(() => {});
    }
  },
  async fetch(input, init) {
    try {
      return await nativeFetch(input, init);
    } catch (error) {
      init?.signal?.throwIfAborted();
      // Keep native transport internals and signed URLs out of UI and logs.
      if (error instanceof TypeError) throw error;
      throw new TypeError("无法连接服务器，请检查网络后重试。");
    }
  },
  WebSocketClass: DesktopSocket,
};

export default desktop;
