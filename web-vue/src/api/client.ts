import platform from "virtual:pulse-platform";
import { prepareImageUpload } from "../features/chat/localImage";
import type { ClientPlatform, RealtimeSocket, UploadAttachment } from "../platform/contracts";
import "../../../client-shared/go-v2.js";
import "../../../client-shared/media-identity.js";
import "../../../web/registration-avatar.js";

export interface LoginResult {
  access_token: string;
  user_id: number;
  expires_at?: string;
}
export type { Profile } from "./types";
import type { Cursor, Delta, Packet, Uploaded, UploadProgress } from "./types";
export interface Config {
  group_member_limit?: number;
  show_group_member_count?: boolean;
  chat_notice?: string;
  register_require_avatar: boolean;
  force_update: boolean;
  minimum_version: string;
  latest_version: string;
}
export interface Challenge {
  challenge_id: string;
  image_data_url: string;
  expires_in: number;
}
interface Options {
  method?: string;
  body?: unknown;
  authToken?: string;
  signal?: AbortSignal;
  onHistoryPage?: (page: import("./types").History) => void;
  onHistoryEnriched?: (page: import("./types").History) => void;
  deferMedia?: boolean;
  retryWrites?: boolean;
}
export interface ApiError extends Error {
  status?: number;
  code?: string;
}
export interface Client {
  base: string;
  tokenKey: string;
  readonly token: string;
  readonly websocketURL: string;
  session(value: string): void;
  request<T>(path: string, options?: Options): Promise<T>;
  raw<T>(path: string, options?: Options): Promise<T>;
  local(type: string, id: string): number;
  directoryChanges(
    known: import("./types").Conversation[],
    options: { signal: AbortSignal; current: () => boolean },
  ): Promise<number[]>;
  wire(type: string, id: number): string;
  delta(
    id: number,
    cursor: Cursor,
    options: {
      signal?: AbortSignal;
      current?: () => boolean;
      deferMedia?: boolean;
    },
  ): Promise<Delta>;
  mediaGrant(
    id: string,
    token?: string,
    signal?: AbortSignal,
    force?: boolean,
  ): Promise<string>;
  uploadMedia(
    kind: string,
    file: UploadAttachment,
    options?: {
      signal?: AbortSignal;
      original?: boolean;
      onProgress?: (value: UploadProgress) => void;
    },
  ): Promise<Uploaded>;
}
import "../../../client-shared/go-realtime.js";
declare global {
  interface Window {
    PulseMediaIdentity: { identity(value: string, hint?: string): string };
    PulseGoV2: {
      create(options: {
        base: string;
        resolveBase?: () => string;
        storage: Storage;
        platform: "web" | "pc";
        fetch?: typeof globalThis.fetch;
        prepareUpload?: ClientPlatform["prepareUpload"];
        prepareImage?: typeof prepareImageUpload;
        clientVersion: string;
      }): Client;
    };
    PulseRegistrationAvatar: {
      prepare(file: File, options?: { signal?: AbortSignal }): Promise<string>;
    };
    PulseGoRealtime: {
      connect(options: {
        api: Client;
        token: string;
        onPacket(packet: Packet): void;
        shared: boolean;
        WebSocketClass?: new (url: string) => RealtimeSocket;
      }): Promise<{ close(): void }>;
    };
  }
}
export const CLIENT_PLATFORM = platform.name;
export const CLIENT_VERSION = platform.version;
export const clientUpdateMessage = CLIENT_PLATFORM === "pc"
  ? "客户端版本过低，请安装新版后重试。"
  : "网页版本需要更新，请刷新页面。";
export const clientUpdatePath =
  `/client/update?platform=${CLIENT_PLATFORM}&version=${encodeURIComponent(CLIENT_VERSION)}`;

export function connectRealtime(options: {
  api: Client;
  token: string;
  onPacket(packet: Packet): void;
  shared: boolean;
}) {
  return window.PulseGoRealtime.connect({ ...options, WebSocketClass: platform.WebSocketClass });
}
export const createClient = () =>
  window.PulseGoV2.create({
    base: platform.apiBase,
    resolveBase: platform.resolveApiBase,
    fetch: platform.fetch,
    prepareUpload: platform.prepareUpload,
    prepareImage: prepareImageUpload,
    storage: localStorage,
    platform: CLIENT_PLATFORM,
    clientVersion: CLIENT_VERSION,
  });
// The guest client is used only for login/config; authenticated accounts own separate instances.
export const client = createClient();
export const request = <T>(path: string, options: Options = {}) =>
  client.request<T>(path, {
    ...options,
    signal: options.signal || AbortSignal.timeout(20000),
  });
export const messageOf = (error: unknown) =>
  error instanceof Error
    ? ["TimeoutError", "AbortError"].includes(error.name)
      ? "请求超时，请检查网络后重试。"
      : error.message
    : "暂时无法完成，请重试。";
