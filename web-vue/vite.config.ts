import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { browserServices } from "./build/browser-services";
import { staticAssets } from "./build/static-assets";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "PULSE_");
  const backend = new URL(env.PULSE_WEB_BACKEND || "https://api.imapi.shop");
  if (
    !["http:", "https:"].includes(backend.protocol) ||
    backend.username ||
    backend.password
  )
    throw Error("Invalid Web backend");
  return {
    plugins: [browserServices(), vue(), staticAssets()],
    publicDir: false,
    base: "./",
    server: {
      port: Number(env.PULSE_WEB_PORT || 18083),
      strictPort: true,
      proxy: {
        "/api/v2": {
          target: backend.origin,
          changeOrigin: true,
          secure: true,
          ws: true,
          configure(proxy) {
            proxy.on("proxyReq", (request) =>
              request.setHeader("Origin", backend.origin),
            );
            proxy.on("proxyReqWs", (request) =>
              request.setHeader("Origin", backend.origin),
            );
          },
        },
      },
    },
    build: { target: "es2022", sourcemap: false, manifest: true },
  };
});
