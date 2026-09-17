import { test, expect } from "./fixtures";

// A fresh browser session, not the shared demoUserStorage fixture: revoking
// this session must not invalidate credentials used by other E2E tests.
test("browser consent connects a CLI with the same identity and logout revokes it", async ({ browser, playwright, baseURL }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  const cli = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.goto("/api/auth/login?provider=demo");
    await page.locator('input[name="login"]').fill("demo-user@demo.kubeport");
    await page.locator('input[name="password"]').fill("demo");
    await page.locator('button[type="submit"]').click();
    await page.waitForLoadState("domcontentloaded");
    const grant = page.locator('button:has-text("Grant Access"), button:has-text("Grant access")');
    if (await grant.count()) await grant.first().click();
    await page.waitForURL(/\/catalog$/, { timeout: 15_000 });

    await page.goto("/cli");
    await expect(page.getByRole("heading", { name: /AI · CLI 연결|Connect AI \/ CLI/ })).toBeVisible();
    await page.getByRole("button", { name: /연결 토큰 발급|Create connection token/ }).click();
    const field = page.getByLabel(/연결 토큰|Connection token/);
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute("type", "password");
    const token = await field.inputValue();
    // Assert only a boolean so a failure never prints the credential.
    expect(token.startsWith("kbp_cli_")).toBe(true);
    const headers = { Authorization: `Bearer ${token}` };

    const me = await cli.get("/api/cli/v1/me", { headers });
    expect(me.status()).toBe(200);
    expect((await me.json()).email).toBe("demo-user@demo.kubeport");
    expect(me.headers()["cache-control"]).toBe("no-store");
    expect((await cli.get("/api/v1/me", { headers })).status()).toBe(401);
    const releases = await cli.get("/api/cli/v1/releases", { headers });
    expect(releases.status()).toBe(200);
    const seeded = (await releases.json()).releases.find((release: { name: string }) => release.name === "app-with-config-demo");
    expect(Boolean(seeded)).toBe(true);
    // This read reaches the real kind API with the session's OIDC token.
    expect((await cli.get(`/api/cli/v1/releases/${seeded.id}`, { headers })).status()).toBe(200);
    expect((await cli.post("/api/cli/v1/teams", { headers, data: { name: "cli-must-not-create", display_name: "x" } })).status()).toBe(403);

    await page.goto("/logout");
    await page.getByRole("button", { name: /로그아웃|Sign out/, exact: true }).click();
    await page.waitForURL(/\/$/);
    expect((await cli.get("/api/cli/v1/me", { headers })).status()).toBe(401);
  } finally {
    await cli.dispose();
    await context.close();
  }
});
