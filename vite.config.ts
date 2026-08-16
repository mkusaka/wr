import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import ssrPlugin from "vite-ssr-components/plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), ssrPlugin()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./web") } },
  build: { outDir: "build" },
});
