/// <reference types="vite/client" />
declare module "virtual:pulse-emoji-data" {
  const groups: { name: string; items: [string, string][] }[];
  export default groups;
}
