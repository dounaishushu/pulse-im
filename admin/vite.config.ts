import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "PULSE_");
  const backend = new URL(
    env.PULSE_ADMIN_BACKEND || "https://admin.imapi.shop",
  );
  if (
    !["http:", "https:"].includes(backend.protocol) ||
    backend.username ||
    backend.password
  )
    throw new Error("Invalid backend URL");
  return {
    plugins: [
      vue(),
      tailwindcss(),
      Components({ dts: false, resolvers: [ElementPlusResolver()] }),
      {
        name: "pulse-admin-notices",
        generateBundle() {
          for (const file of [
            "THIRD_PARTY_NOTICES.md",
            "third-party/ArtDesign.LICENSE",
          ])
            this.emitFile({
              type: "asset",
              fileName: file,
              source: readFileSync(
                fileURLToPath(new URL("./" + file, import.meta.url)),
                "utf8",
              ),
            });
        },
      },
    ],
    optimizeDeps: { entries: ["src/**/*.vue", "src/**/*.ts"] },
    server: {
      port: Number(env.PULSE_ADMIN_PORT || 18100),
      strictPort: true,
      proxy: {
        "/api/v2": {
          target: backend.origin,
          changeOrigin: true,
          secure: true,
          cookieDomainRewrite: "",
          configure(proxy) {
            proxy.on("proxyReq", (req) => {
              req.setHeader("Origin", backend.origin);
            });
          },
        },
      },
    },
    build: {
      target: "es2022",
      sourcemap: false,
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          entry: fileURLToPath(new URL("./entry.html", import.meta.url)),
        },
      },
    },
  };
});
