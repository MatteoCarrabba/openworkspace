import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the dashboard to ONE self-contained dist/index.html — all JS/CSS
// inlined, no external chunks, no CDN references. The root `build:client`
// script (see repo root package.json) copies that single file to
// dist/src/dashboard/index.html, which src/dashboard/server.ts serves as-is.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    // vite-plugin-singlefile inlines everything into one HTML; a single
    // output chunk keeps that inlining simple and avoids any async imports
    // that would otherwise turn into cross-file <script> references.
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    modulePreload: false,
    target: "esnext",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    // Local `vite` dev server proxies API calls to a dashboard already
    // running on the default port (see README in this dir).
    proxy: {
      "/api": "http://127.0.0.1:4173",
    },
  },
});
