import { shallowRef, computed } from "vue";
import { get, post, transport } from "../api/client";
import { pages } from "../domain/catalog";
import type { AdminAccount } from "../domain/types";

const account = shallowRef<AdminAccount | null>(null);
const ready = shallowRef(false);
const message = shallowRef("");
const generation = shallowRef(0);
const isSuper = computed(
  () => account.value?.is_super_admin || account.value?.role === "admin",
);
let refreshPromise: Promise<void> | null = null;
export function can(key: string, manage = false) {
  if (!account.value) return false;
  if (key === "admin-accounts") return !!isSuper.value;
  const page = pages.find((p) => p.key === key);
  if (!page || (manage && !page.manage)) return false;
  if (isSuper.value) return true;
  const permissions = account.value.permissions || [];
  return (
    permissions.includes(`${key}.view`) &&
    (!manage ||
      (account.value.role !== "auditor" &&
        permissions.includes(`${key}.manage`)))
  );
}
export function clearSession(reason = "") {
  generation.value++;
  account.value = null;
  message.value = reason;
  transport.reset();
  sessionStorage.removeItem(transport.csrfKey);
}
async function refresh() {
  if (refreshPromise) return refreshPromise;
  const initial = generation.value;
  refreshPromise = (async () => {
    try {
      const result = await get<{ admin: AdminAccount }>("/admin/auth/me");
      if (generation.value === initial) account.value = result.admin;
    } catch (error: any) {
      if (generation.value === initial && error.status === 401 && account.value)
        clearSession("登录已失效，请重新登录");
      if (generation.value === initial && error.status !== 401)
        message.value = error.message;
    } finally {
      ready.value = true;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}
async function login(username: string, password: string) {
  const result = await post("/admin/auth/login", {
    username,
    password,
    session_mode: "cookie",
  });
  if (!result.admin || result.session_mode !== "cookie" || !result.csrf_token)
    throw new Error("登录响应异常，请刷新重试");
  generation.value++;
  account.value = result.admin;
  message.value = "";
}
async function logout() {
  try {
    await post("/admin/auth/logout");
  } finally {
    clearSession();
  }
}
window.addEventListener("pulse:session-expired", () =>
  clearSession("登录已失效，请重新登录"),
);
window.addEventListener("pulse:permissions-changed", () => {
  if (account.value) void refresh();
});
export function useSession() {
  return {
    account,
    ready,
    message,
    generation,
    isSuper,
    can,
    refresh,
    login,
    logout,
  };
}
