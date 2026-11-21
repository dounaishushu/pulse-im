import type { ClientPlatform } from "./contracts";

const browser: ClientPlatform = {
  name: "web",
  get apiBase() { return location.origin + "/api/v2"; },
  version: "2.4.198",
  async initialize() {},
  fetch: globalThis.fetch.bind(globalThis),
};

export default browser;
