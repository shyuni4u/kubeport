import { test, expect, adminStorage } from "./fixtures";

test.describe("deprecate flow", () => {
  test.use({ storageState: async ({}, use) => use(await adminStorage()) });

  test("publish → deprecate → hidden from catalog → undeprecate", async ({ page }) => {
    // Depends on 02-ui-editor having created a fresh e2e-ui-* draft template.
    // Files run in alphabetical order; the e2e-ui-* prefix is set by ui-editor
    // and avoids picking up stale templates from prior sessions (unit-test
    // residue, or deprecate-flow retries).
    await page.goto("/templates");
    const rowLinks = page.locator('table a[href^="/templates/e2e-ui-"]');
    await rowLinks.first().waitFor({ timeout: 10_000 });
    // Use the most recently created one (highest Date.now() suffix → last link
    // in the list when sorted alphabetically).
    const count = await rowLinks.count();
    const rowLink = rowLinks.nth(count - 1);
    const href = await rowLink.getAttribute("href");
    expect(href).toBeTruthy();
    const slug = href!.replace(/^\/templates\//, "");
    await rowLink.click();
    // Let the server-rendered template detail page hydrate before clicking
    // server-action form buttons; clicking pre-hydration falls back to a
    // plain HTML submit that doesn't reach the Go API.
    await page.waitForLoadState("networkidle");

    // If v1 is still draft, publish it first.
    const publishBtn = page.getByRole("button", { name: /^Publish$/ });
    if (await publishBtn.count() > 0) {
      await publishBtn.first().click();
      await page.waitForLoadState("networkidle");
      await page.reload();
      await expect(page.getByText("published", { exact: true }).first()).toBeVisible({
        timeout: 15_000,
      });
    }

    // Deprecate
    const deprecateBtn = page.getByRole("button", { name: /^Deprecate$/ });
    await expect(deprecateBtn.first()).toBeVisible({ timeout: 10_000 });
    await deprecateBtn.first().click();
    await page.waitForLoadState("networkidle");
    await page.reload();
    await expect(page.getByText("deprecated").first()).toBeVisible({ timeout: 10_000 });

    // Catalog no longer shows it
    await page.goto("/catalog");
    await expect(page.locator(`a[href^="/catalog/${slug}"]`)).toHaveCount(0);

    // Undeprecate restores it
    await page.goto(`/templates/${slug}`);
    const undeprecateBtn = page.getByRole("button", { name: /^Undeprecate$/ });
    await expect(undeprecateBtn.first()).toBeVisible({ timeout: 10_000 });
    await undeprecateBtn.first().click();
    await page.waitForLoadState("networkidle");
    await page.reload();
    await expect(page.getByText("published").first()).toBeVisible({ timeout: 10_000 });
    await page.goto("/catalog");
    await expect(page.locator(`a[href^="/catalog/${slug}"]`).first()).toBeVisible();
  });
});
