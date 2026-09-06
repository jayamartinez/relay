import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ["packages/**/*.test.ts", "apps/extension/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
  },
});
