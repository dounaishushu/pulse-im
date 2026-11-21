const KEY = "pulse_lock_settings";

interface LocalPasscode {
  enabled: true;
  hash: string;
  locked: boolean;
}

export function readLocalPasscode(): LocalPasscode | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!saved || typeof saved !== "object" || !("enabled" in saved) || saved.enabled !== true) return null;
    return {
      enabled: true,
      hash: "hash" in saved && typeof saved.hash === "string" ? saved.hash : "",
      locked: "locked" in saved && saved.locked === true,
    };
  } catch {
    return null;
  }
}

export function saveLocalPasscode(value: LocalPasscode | null) {
  if (value) localStorage.setItem(KEY, JSON.stringify(value));
  else localStorage.removeItem(KEY);
}

export async function hashLocalPasscode(code: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
