import { readonly, shallowRef } from "vue";
import { client, request, messageOf } from "../api/client";
import type { LoginResult, Profile, Config } from "../api/client";

export function useSession() {
  const phase = shallowRef<"checking" | "login" | "workspace" | "error">(
    "checking",
  );
  const error = shallowRef("");
  let revision = 0;
  const config = shallowRef<Config | null>(null);
  async function enter(token = localStorage.getItem(client.tokenKey) || "") {
    const mine = ++revision;
    error.value = "";
    phase.value = "checking";
    client.session(token);
    try {
      config.value = await request<Config>("/client/config", { authToken: "" });
      if (mine !== revision) return;
      if (
        config.value.force_update &&
        compare(
          config.value.minimum_version || config.value.latest_version,
          "2.4.192",
        ) > 0
      )
        throw Error("网页版本需要更新，请刷新页面后重试。");
      if (!token) {
        phase.value = "login";
        return;
      }
      await request<Profile>("/auth/me");
      if (mine !== revision) return;
      localStorage.setItem(client.tokenKey, token);
      phase.value = "workspace";
    } catch (cause) {
      if (mine !== revision) return;
      const status = (cause as { status?: number }).status;
      if (status === 401) {
        localStorage.removeItem(client.tokenKey);
        client.session("");
        phase.value = "login";
      } else {
        error.value = messageOf(cause);
        phase.value = "error";
      }
    }
  }
  async function authenticated(result: LoginResult) {
    // Preserve a successfully issued session even when later initialization fails.
    localStorage.setItem(client.tokenKey, result.access_token);
    await enter(result.access_token);
  }
  function loginRequired() {
    ++revision;
    client.session("");
    localStorage.removeItem(client.tokenKey);
    phase.value = "login";
  }
  function failed(cause: unknown) {
    ++revision;
    error.value = messageOf(cause);
    phase.value = "error";
  }
  return {
    phase: readonly(phase),
    error: readonly(error),
    config: readonly(config),
    enter,
    authenticated,
    loginRequired,
    failed,
  };
}
function compare(a: string, b: string) {
  const av = a.split(".").map(Number),
    bv = b.split(".").map(Number);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const delta = (av[i] || 0) - (bv[i] || 0);
    if (delta) return delta;
  }
  return 0;
}
