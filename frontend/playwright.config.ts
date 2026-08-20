import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Server-action + revalidatePath flows occasionally need a retry in CI;
  // locally we want to see real failures immediately.
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: process.env.KBP_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Tests assume the full local-e2e.md stack is already running (compose + kind
  // + backend + frontend dev). Playwright doesn't boot them.
  workers: 1,
});
