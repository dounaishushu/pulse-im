import type { Plugin } from "vite";
// Preserve the reviewed service bodies while selecting their original browser
// export branch. Without this boundary, Rolldown identifies local UMD files as
// CommonJS and the side-effect imports never initialize their window API.
const services = new Set([
  "client-shared/go-v2.js",
  "client-shared/go-realtime.js",
  "client-shared/media-identity.js",
  "client-shared/text-outbox.js",
  "web/pending-text-store.js",
  "web/contact-names.js",
  "web/conversation-refresh.js",
  "web/voice-format.js",
]);
export function browserServices(): Plugin {
  return {
    name: "pulse-browser-services",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0]!.replaceAll("\\", "/");
      if (![...services].some((name) => file.endsWith("/" + name))) return;
      const branches = [
        ...code.matchAll(
          /\bif\s*\(\s*typeof module\b[^)]*\)\s*module\.exports\s*=\s*[^;]+;/g,
        ),
      ];
      if (branches.length !== 1)
        throw Error("Unexpected shared service export guard: " + file);
      return {
        code: code.replace(branches[0]![0], "if (false) {}") + "\nexport {};\n",
        map: null,
      };
    },
  };
}
