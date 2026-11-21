/// <reference types="vite/client" />
declare module "virtual:pulse-platform" {
  const platform: import("./platform/contracts").ClientPlatform;
  export default platform;
}

declare module "virtual:pulse-emoji-data" {
  const groups: { name: string; items: [string, string][] }[];
  export default groups;
}
