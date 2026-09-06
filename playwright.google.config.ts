import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "google-probe.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: "line",
  outputDir: "output/google-probe",
  use: { trace: "off" },
});
