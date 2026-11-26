import type { DesktopClientExit } from "./contracts";

const endpoint = "https://my.ippure.com/v1/info";
function part(value: unknown) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= 128 && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
}
function validIP(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value.split(".").every(n => Number(n) <= 255);
  if (!/^[\da-f:]+$/i.test(value) || !value.includes(":")) return false;
  try { return new URL(`http://[${value}]/`).hostname.startsWith("["); } catch { return false; }
}

// This self-IP endpoint must be queried by the user's browser. Cross-origin
// failure is advisory: never substitute a server/administrator IP or use no-cors.
export async function browserIPPureExit(provider: string, signal: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<DesktopClientExit | null> {
  if (provider !== endpoint || signal.aborted) return null;
  try {
    const response = await fetcher(endpoint, {
      method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
      redirect: "error", referrerPolicy: "no-referrer",
      signal: AbortSignal.any([signal, AbortSignal.timeout(4500)]),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); return null; }
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16384) { await reader.cancel(); return null; }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object" || !validIP(value.ip) || signal.aborted) return null;
    const location = { country: part(value.country), province: part(value.region), city: part(value.city), district: part(value.district) };
    return {
      exit_ip: value.ip,
      risk_score: Number.isInteger(value.fraudScore) && value.fraudScore >= 0 && value.fraudScore <= 100 ? value.fraudScore : null,
      is_residential: typeof value.isResidential === "boolean" ? value.isResidential : null,
      is_broadcast: typeof value.isBroadcast === "boolean" ? value.isBroadcast : null,
      ...(Object.values(location).some(Boolean) ? { exit_location: location } : {}),
    };
  } catch { return null; }
}
