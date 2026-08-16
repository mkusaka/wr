import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./worker/index.ts",
      miniflare: {
        d1Databases: ["DB"],
        bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") },
      },
    })),
  ],
  test: {
    include: ["test-worker/**/*.test.ts"],
    setupFiles: ["./test-worker/setup.ts"],
  },
});
