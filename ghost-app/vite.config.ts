import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
      "/api": { target: "http://127.0.0.1:8080" },
      "/health": { target: "http://127.0.0.1:8080" },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
});
