import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import ssrPlugin from "vite-ssr-components/plugin";

// Avoid adding a second SSR environment; Cloudflare already owns this build.
const pwaPlugins = VitePWA({
  injectRegister: false,
  manifest: {
    name: "wr",
    short_name: "wr",
    description:
      "A relationship ledger for tasks, sessions, checkouts, pull requests, and workpads.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#18181b",
    icons: [
      { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
    ],
  },
  workbox: { navigateFallback: undefined },
}).map((plugin) =>
  plugin.name === "vite-plugin-pwa" ? Object.assign(plugin, { config: undefined }) : plugin,
);

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), ssrPlugin(), ...pwaPlugins],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./web") } },
  build: { outDir: "build" },
});
