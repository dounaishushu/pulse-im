import { defineConfig } from "@playwright/test";
const baseURL = process.env.PULSE_ADMIN_UI_URL;
if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname))
  throw new Error("Set PULSE_ADMIN_UI_URL to the isolated local admin UI");
if (!process.env.PULSE_ADMIN_FIXTURE)
  throw new Error("Set PULSE_ADMIN_FIXTURE to an isolated fixture file");
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 180000,
  expect: { timeout: 10000 },
  reporter: "list",
  outputDir: "test-results",
  use: {
    baseURL,
    channel: "chrome",
    headless: true,
    actionTimeout: 15000,
    navigationTimeout: 20000,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
