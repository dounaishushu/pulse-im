export interface RealtimeSocket {
  readonly readyState: number;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface DownloadTask {
  id: string;
  name: string;
  status: "queued" | "running" | "saved" | "failed" | "cancelled";
  received: number;
  total: number | null;
  error: string | null;
  savedPath: string | null;
}

export interface DesktopDownloadPreferences {
  directory: string;
  askBeforeDownload: boolean;
}

export interface LegacyDownloadPreferences {
  directory?: string;
  askBeforeDownload?: boolean;
}

export interface DesktopDownloads {
  preferences(token: string): Promise<DesktopDownloadPreferences>;
  chooseDirectory(token: string, legacy?: LegacyDownloadPreferences): Promise<DesktopDownloadPreferences | null>;
  setAskBeforeDownload(token: string, enabled: boolean): Promise<DesktopDownloadPreferences>;
  start(spec: { mediaId: string; name: string; token: string }): Promise<string | null>;
  list(token: string): Promise<DownloadTask[]>;
  cancel(id: string, token: string): Promise<void>;
  release(token: string): Promise<void>;
}

export interface DesktopSystemOptions {
  tray: boolean;
  taskbar: boolean;
  autoLaunch: boolean | null;
  sendTo: boolean | null;
}

export interface ExplorerAttachment {
  readonly source: "explorer";
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export type UploadAttachment = File | ExplorerAttachment;

export interface DesktopExplorerFiles {
  pending(token: string): Promise<ExplorerAttachment[]>;
  claim(token: string, ids: string[]): Promise<ExplorerAttachment[]>;
  unclaim(token: string, ids: string[]): Promise<void>;
  discard(token: string, ids: string[]): Promise<void>;
  subscribe(listener: (warning: string | null) => void): Promise<() => void>;
}

export interface NoticeInput {
  scope: string;
  conversationId: number;
  title: string;
  body: string;
  silent: boolean;
  limit: number;
}

export interface NoticeClick {
  scope: string;
  conversationId: number;
  reply: boolean;
}

export interface NoticeView {
  id: string;
  title: string;
  body: string;
}

export type NoticeAction = "open" | "reply" | "close" | "hover" | "leave";

export interface RememberedSignIn {
  id: string;
  account: string;
}

export interface SignInDetails {
  account: string;
  password: string;
}

export interface PreparedUpload {
  sha256: string;
  send(url: string, init: RequestInit): Promise<Response>;
  release(): Promise<void>;
}

export interface ArchiveSession {
  user: string;
  token: string;
}

export interface ArchiveHistory {
  conversation: string;
  title: string;
  kind: string;
  theme: string;
  eventSeq?: string;
}

export interface ArchiveMessage {
  id: string;
  seq: string;
  name: string;
  avatar: string | null;
  mine: boolean;
  kind: string;
  text: string;
  createdAt: string;
  media: {
    id: string;
    filename: string;
    mime: string;
    bytes: string;
    width: number;
    height: number;
  } | null;
  contact: { nickname: string; account: string } | null;
}

export type ConversationWindowInput = Omit<ArchiveHistory, "eventSeq"> & { connected: boolean };

export interface ConversationWindowContext extends ConversationWindowInput {
  lease: string;
  token: string;
  user: string;
}

export type ChatOutboxAction =
  | { type: "list" }
  | { type: "send"; requestId: string; body: import("../api/types").MessageBody }
  | { type: "retry" | "discard"; id: string };

export interface ChatOutboxSnapshot {
  version: number;
  items: { id: string; status: string; error: string; text: string }[];
}

export interface ChatOutboxRequest {
  request: string;
  user: string;
  conversation: string;
  action: ChatOutboxAction;
}

export interface DesktopChatWindows {
  open(token: string, input: ConversationWindowInput): Promise<void>;
  closeAll(token?: string): void;
  relay(token: string, packet: import("../api/types").Packet): void;
  context(): Promise<ConversationWindowContext>;
  outbox(action: ChatOutboxAction): Promise<ChatOutboxSnapshot>;
  onOutboxStatus(callback: (snapshot: ChatOutboxSnapshot) => void): Promise<() => void>;
  onOutboxRequest(callback: (request: ChatOutboxRequest) => void): Promise<() => void>;
  replyOutbox(token: string, request: string, snapshot?: ChatOutboxSnapshot, error?: string): Promise<boolean>;
  publishOutbox(token: string, conversation: string, snapshot: ChatOutboxSnapshot): Promise<boolean>;
  subscribe(callback: (packet: import("../api/types").Packet) => void): Promise<() => void>;
  close(): Promise<void>;
}

export interface DesktopArchive {
  copyImage(token: string, conversation: string, message: string): Promise<void>;
  setSession(input: ArchiveSession | null): void;
  openHistory(token: string, input: ArchiveHistory): Promise<void>;
  openImage(token: string, conversation: string, message: string, eventSeq?: string): Promise<void>;
  invalidate(token: string, conversation?: string): void;
  observe(token: string, conversation: string, through: string): void;
}

export interface ArchiveUpdate {
  reload: boolean;
  removed: string[];
}

export interface DesktopArchiveWindow {
  history(): Promise<ArchiveHistory>;
  page(older: boolean): Promise<{ items: ArchiveMessage[]; hasMore: boolean }>;
  assets(ids: string[]): Promise<Record<string, string>>;
  copyText(message: string): Promise<void>;
  copyImage(message?: string): Promise<void>;
  download(message: string): Promise<boolean>;
  preview(message: string): Promise<void>;
  image(): Promise<{ name: string; url: string }>;
  onHistoryChange(callback: (update: ArchiveUpdate) => void): Promise<() => void>;
  onImageChange(callback: () => void): Promise<() => void>;
  close(): Promise<void>;
}

export interface ScreenSelection { left: number; top: number; right: number; bottom: number; }
export interface DesktopScreenshot { take(signal: AbortSignal): Promise<File | null>; }
export interface ScreenshotOverlay {
  preview(): Promise<{ image: Blob; width: number; height: number }>;
  complete(selection: ScreenSelection): Promise<void>;
  cancel(): Promise<void>;
}

export type DesktopWindowKind = "workspace" | "notification" | "history" | "image" | "conversation" | "screenshot";

export interface WorkspaceGroup {
  id: string;
  title: string;
  opened: boolean;
  current: boolean;
}

export interface DesktopWorkspaces {
  list(): Promise<WorkspaceGroup[]>;
  importLegacy(): Promise<number | null>;
  open(group?: string): Promise<void>;
  primary(): Promise<void>;
}

export interface TrayAccount {
  id: number;
  revision: string;
  name: string;
  active: boolean;
  signedIn: boolean;
}

export interface TrayAccountAction {
  id: number;
  revision: string;
  action: "open" | "logout" | "remove";
}

export interface DesktopTrayAccounts {
  sync(rows: TrayAccount[], locked: boolean): Promise<void>;
  subscribe(listener: (event: TrayAccountAction) => void): Promise<() => void>;
}

export interface ChatTypography {
  size: number;
  family: "yahei" | "song" | "hei" | "kai" | "system";
  bold: boolean;
}
export interface TypographyState { revision: number; value: ChatTypography; }
export interface DesktopChatTypography {
  read(): Promise<TypographyState>;
  save(value: ChatTypography): Promise<TypographyState>;
  importLegacy(): Promise<TypographyState | null>;
  subscribe(update: (snapshot: TypographyState) => void): Promise<() => void>;
}

export type DesktopDiagnosticEvent =
  | "workspaceMounted"
  | "rendererLongTask"
  | "rendererError"
  | "realtimeDisconnected"
  | "httpUnavailable"
  | "httpBusy";

export interface DesktopDiagnostics {
  report(event: DesktopDiagnosticEvent, durationMs?: number): void;
  openLogs(): Promise<void>;
}

export interface DesktopRelease {
  currentVersion: string;
  latestVersion: string;
  minimumVersion: string;
  required: boolean;
  available: boolean;
  notes: string;
  downloadable: boolean;
}

export interface DesktopUpdates {
  check(manual?: boolean): Promise<DesktopRelease>;
  openDownload(version: string): Promise<void>;
}

export interface DesktopRoute {
  id: string;
  name: string;
  latencyMs: number | null;
}

export interface DesktopRouteDirectory {
  currentId: string;
  base: string;
  origins: string[];
  routes: DesktopRoute[];
}

export interface DesktopRoutes {
  list(refresh?: boolean): Promise<DesktopRouteDirectory>;
  probe(id: string): Promise<DesktopRouteDirectory>;
  select(id: string): Promise<DesktopRouteDirectory>;
}

export type DesktopProxyMode = "direct" | "system" | "custom";

export interface DesktopProxyPreset {
  id: string;
  name: string;
  url: string;
}

export interface DesktopNetworkPreferences {
  mode: DesktopProxyMode;
  proxyUrl: string;
  useIpv6: boolean;
  saved: DesktopProxyPreset[];
  activeProxyId: string | null;
}

export interface DesktopNetworkOptions extends DesktopNetworkPreferences {
  revision: string;
  readError: boolean;
}

export interface DesktopClientExit {
  exit_ip: string;
  risk_score: number | null;
  is_residential: boolean | null;
  is_broadcast: boolean | null;
}

export interface DesktopNetwork {
  read(): Promise<DesktopNetworkOptions>;
  save(preferences: DesktopNetworkPreferences, revision: string): Promise<DesktopNetworkOptions>;
  test(preferences: DesktopNetworkPreferences, id: string): Promise<number>;
  cancelTest(id: string): Promise<void>;
  checkExit(token: string, provider: string): Promise<DesktopClientExit | null>;
}

export interface ClientPlatform {
  readonly chatTypography?: DesktopChatTypography;
  readonly prepareUpload?: (file: UploadAttachment, token: string, signal?: AbortSignal) => Promise<PreparedUpload>;
  readonly signIns?: {
    list(): Promise<RememberedSignIn[]>;
    read(id: string): Promise<SignInDetails | null>;
    save(value: SignInDetails & { userId: number; remember: boolean }): Promise<void>;
    forget(id: string): Promise<void>;
  };
  readonly windowKind?: DesktopWindowKind;
  readonly archive?: DesktopArchive;
  readonly screenshot?: DesktopScreenshot;
  readonly screenshotOverlay?: ScreenshotOverlay;
  readonly chatWindows?: DesktopChatWindows;
  readonly workspaces?: DesktopWorkspaces;
  readonly trayAccounts?: DesktopTrayAccounts;
  readonly diagnostics?: DesktopDiagnostics;
  readonly updates?: DesktopUpdates;
  readonly routes?: DesktopRoutes;
  readonly network?: DesktopNetwork;
  readonly resolveApiBase?: () => string;
  readonly mediaSource?: (input: string) => string;
  readonly archiveWindow?: DesktopArchiveWindow;
  readonly notifications?: {
    show(notice: NoticeInput): Promise<void>;
    clear(scope: string): Promise<void>;
    subscribe(action: (event: NoticeClick) => void): Promise<() => void>;
  };
  readonly noticeWindow?: {
    snapshot(): Promise<NoticeView[]>;
    ready(): Promise<void>;
    subscribe(listener: () => void): Promise<() => void>;
    act(id: string, action: NoticeAction): Promise<void>;
  };
  readonly system?: {
    openSoundSettings(): Promise<void>;
    read(): Promise<DesktopSystemOptions>;
    set(key: keyof DesktopSystemOptions, enabled: boolean): Promise<DesktopSystemOptions>;
  };
  readonly downloads?: DesktopDownloads;
  readonly clearResourceCache?: (token: string) => Promise<void>;
  readonly explorerFiles?: DesktopExplorerFiles;
  readonly name: "web" | "pc";
  readonly apiBase: string;
  readonly version: string;
  initialize(): Promise<void>;
  readonly fetch: typeof globalThis.fetch;
  readonly WebSocketClass?: new (url: string) => RealtimeSocket;
}
