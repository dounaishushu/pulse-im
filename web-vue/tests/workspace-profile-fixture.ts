// Real App/session/workspace with two isolated synthetic accounts. HTTP is
// intercepted by workspace-profile.e2e.cjs; no production credentials are used.
import { createApp } from "vue";
import App from "../src/App.vue";
import { createClient } from "../src/api/client";
import { createAccountVault } from "../src/features/accounts/accountVault";

// Exercise the supported deferred-media state explicitly: identity arrives
// first, while visible AvatarImage components resolve their authorized URLs.
const create = window.PulseGoV2.create;
window.PulseGoV2.create = options => {
  const api = create(options);
  const request = api.request;
  api.request = (path, options) => request(path, path === "/auth/me" ? { ...options, deferMedia: true } : options);
  return api;
};
const client = createClient();
const vault = createAccountVault(client.base);
if (!(await vault.list()).length) {
  for (const n of [1, 2]) {
    const id = client.local("user", `0000000${n}-eeee-4eee-8eee-eeeeeeeeeeee`);
    await vault.save({
      id,
      token: `workspace-profile-${n}`,
      revision: crypto.randomUUID(),
      profile: {
        id, user_id: id, username: `account${n}`,
        nickname: n === 1 ? "账号甲" : "账号乙",
        avatar_url: "", public_id: `PROFILE${n}`, signature: "",
      },
    });
  }
}
window.PulseGoRealtime.connect = async () => ({ close() {} });
createApp(App).mount("#app");
