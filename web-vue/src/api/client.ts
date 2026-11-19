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
    options: { signal?: AbortSignal; current?: () => boolean },
  ): Promise<Delta>;
  mediaGrant(
    id: string,
    token?: string,
    signal?: AbortSignal,
    force?: boolean,
  ): Promise<string>;
  uploadMedia(
    kind: string,
    file: File,
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
        storage: Storage;
        platform: string;
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
      }): Promise<{ close(): void }>;
    };
  }
}
export const WEB_VERSION = "2.4.198";
export const createClient = () =>
  window.PulseGoV2.create({
    base: location.origin + "/api/v2",
    storage: localStorage,
    platform: "web",
    clientVersion: WEB_VERSION,
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
