import { test as base, expect, chromium } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";

/**
 * OIDC flow is real (dex → Next.js callback → DB session). We perform a
 * one-time login per user and reuse the storage state across tests.
 *
 * Dex uses a self-signed cert in local dev; the browser context ignores
 * HTTPS errors so the redirect chain doesn't trip on it.
 */
const BASE_URL = process.env.KBP_BASE_URL ?? "http://localhost:3000";

async function loginAs(
  email: string,
  password: string,
  stateFile: string,
  provider: "primary" | "demo" = "primary",
): Promise<void> {
  if (existsSync(stateFile)) return;
  const browser = await chromium.launch();
  // The fixture bypasses playwright.config's `use.baseURL` (we create our
  // own context here), so all URLs must be absolute.
  const ctx = await browser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const loginUrl =
    provider === "demo"
      ? `${BASE_URL}/api/auth/login?provider=demo&hint=${encodeURIComponent(email)}`
      : `${BASE_URL}/api/auth/login`;
  await page.goto(loginUrl);
  // Dex login form — input names are "login" (email) and "password"
  await page.locator('input[name="login"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  // Dex shows an approval/consent page after login on first auth. Click
  // "Grant Access" to continue; on subsequent logins this page is skipped,
  // so treat the button as optional.
  await page.waitForLoadState("domcontentloaded");
  const grant = page.locator('button:has-text("Grant Access"), button:has-text("Grant access")');
  if (await grant.count() > 0) {
    await grant.first().click();
  }
  // Callback redirects to /catalog.
  await page.waitForURL(/\/(catalog)?$|\/templates|\/admin/, { timeout: 15_000 });
  mkdirSync("tests/e2e/.auth", { recursive: true });
  await ctx.storageState({ path: stateFile });
  await browser.close();
}

export const test = base;
export { expect };

/**
 * Destructive / irreversible actions are wrapped in window.confirm
 * (ConfirmSubmit, DeleteReleaseButton, the editor's unsaved-edits guard).
 * Playwright dismisses dialogs by default, which silently cancels them —
 * call this at the top of a test that expects to go through one.
 */
export function autoAcceptDialogs(page: import("@playwright/test").Page): void {
  page.on("dialog", (d) => d.accept());
}

export async function adminStorage(): Promise<string> {
  const p = "tests/e2e/.auth/admin.json";
  await loginAs("admin@example.com", "admin", p);
  return p;
}

export async function aliceStorage(): Promise<string> {
  const p = "tests/e2e/.auth/alice.json";
  await loginAs("alice@example.com", "alice", p);
  return p;
}

export async function demoAdminStorage(): Promise<string> {
  const p = "tests/e2e/.auth/demo-admin.json";
  await loginAs("demo-admin@demo.kubeport", "demo", p, "demo");
  return p;
}

export async function demoUserStorage(): Promise<string> {
  const p = "tests/e2e/.auth/demo-user.json";
  await loginAs("demo-user@demo.kubeport", "demo", p, "demo");
  return p;
}
