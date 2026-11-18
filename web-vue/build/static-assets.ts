import type { Plugin } from "vite";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const web = fileURLToPath(new URL("../../web", import.meta.url));
export function staticAssets(): Plugin {
  return {
    name: "pulse-static-assets",
    resolveId(id) {
      return id === "virtual:pulse-emoji-data" ? "\0" + id : null;
    },
    load(id) {
      if (id !== "\0virtual:pulse-emoji-data") return;
      const file = path.join(web, "emoji-data.js");
      this.addWatchFile(file);
      return readFileSync(file, "utf8").replace(
        /const telegramEmojiGroups\s*=\s*/,
        "export default ",
      );
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url || "/", "http://localhost").pathname;
        if (!pathname.startsWith("/emoji/") && pathname !== "/app-icon.png")
          return next();
        let file: string;
        try {
          file = path.resolve(web, "." + decodeURIComponent(pathname));
        } catch {
          return next();
        }
        if (
          !file.startsWith(web + path.sep) ||
          !statSync(file, { throwIfNoEntry: false })?.isFile()
        )
          return next();
        res.setHeader(
          "Content-Type",
          file.endsWith(".svg") ? "image/svg+xml" : "image/png",
        );
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      const visit = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) throw Error("Symlink in Web assets");
          if (entry.isDirectory()) visit(file);
          else
            this.emitFile({
              type: "asset",
              fileName: path.relative(web, file).replaceAll("\\", "/"),
              source: readFileSync(file),
            });
        }
      };
      visit(path.join(web, "emoji"));
      this.emitFile({
        type: "asset",
        fileName: "app-icon.png",
        source: readFileSync(path.join(web, "app-icon.png")),
      });
    },
  };
}
