import "../go-api.js";
import type { RecordData } from "../domain/types";

export const transport = window.PulseGoAdmin;
export async function request<T = RecordData>(
  path: string,
  options: RequestInit & { body?: any } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(30000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    return await transport.request<T>(path, { ...options, signal });
  } catch (error: any) {
    if (timeout.aborted && !options.signal?.aborted)
      throw new Error("请求超时，请重试");
    if (
      error.status === 401 &&
      !["/admin/auth/login", "/admin/auth/me"].includes(path)
    )
      window.dispatchEvent(new Event("pulse:session-expired"));
    if (error.status === 403)
      window.dispatchEvent(new Event("pulse:permissions-changed"));
    if (error instanceof TypeError)
      throw new Error("连接失败，请检查网络后重试");
    throw error;
  }
}
export const get = <T = RecordData>(path: string, signal?: AbortSignal) =>
  request<T>(path, { signal });
export const post = <T = RecordData>(
  path: string,
  body: RecordData = {},
  signal?: AbortSignal,
) => request<T>(path, { method: "POST", body: JSON.stringify(body), signal });
export const query = (path: string, values: RecordData) =>
  path +
  "?" +
  new URLSearchParams(
    Object.entries(values)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );
export async function upload(path: string, file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append("file", file);
  return transport.upload(path, form, signal);
}
export async function download(path: string, filename: string) {
  const response = await transport.download(path, AbortSignal.timeout(120000));
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
  saveBlob(await response.blob(), filename);
}
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
export function mediaURL(value: string) {
  const url = transport.mediaURL(value || "");
  if (!url) return "";
  try {
    const parsed = new URL(url, location.origin);
    if (
      parsed.username ||
      parsed.password ||
      (parsed.protocol === "blob:" && parsed.origin !== location.origin)
    )
      return "";
    return ["https:", "http:", "blob:"].includes(parsed.protocol)
      ? parsed.href
      : "";
  } catch {
    return "";
  }
}
