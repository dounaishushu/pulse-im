import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const key = "virtual:pulse-platform";

export function clientPlatform(desktop: boolean): Plugin {
  return {
    name: "pulse-client-platform",
    resolveId(id) {
      if (id === key) return "\0" + key;
    },
    load(id) {
      if (id !== "\0" + key) return;
      const path = fileURLToPath(new URL(
        desktop ? "../../pc-tauri/frontend/platform.ts" : "../src/platform/browser.ts",
        import.meta.url,
      )).replaceAll("\\", "/");
      return `export { default } from ${JSON.stringify(path)};`;
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (desktop) return html.replace("/src/main.ts", "/src/desktop-entry.ts");
      },
    },
  };
}
