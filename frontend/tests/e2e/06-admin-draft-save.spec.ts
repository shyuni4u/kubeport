import { test, expect, demoAdminStorage } from "./fixtures";

// Admin persona on the seeded `web-app` draft: edit metadata in the draft's
// native (YAML) mode, verify the unsaved-edits guard on tab switch, save
// (template meta goes through PATCH — the BFF proxy bug from PR #7), and
// land on the detail page with the change applied. Restores the name at the
// end so the demo catalog assertions elsewhere keep matching.
test.describe("demo admin edits the seeded draft", () => {
  test.use({ storageState: async ({}, provide) => provide(await demoAdminStorage()) });

  async function openDraftEditor(page: import("@playwright/test").Page): Promise<void> {
    await page.goto("/templates/web-app");
    // The draft is the newest version → last edit link on the page.
    const editLinks = page.locator('a[href*="/versions/"][href*="/edit"]');
    await editLinks.first().waitFor({ timeout: 10_000 });
    const href = await editLinks.last().getAttribute("href");
    expect(href).toBeTruthy();
    const url = new URL(href!, "http://x");
    url.searchParams.set("mode", "yaml");
    await page.goto(url.pathname + url.search);
    await expect(page.getByPlaceholder("표시 이름")).toBeVisible({ timeout: 15_000 });
  }

  test("unsaved-edits guard, PATCH save, name persists", async ({ page }) => {
    await openDraftEditor(page);
    const displayName = page.getByPlaceholder("표시 이름");
    const original = await displayName.inputValue();
    const changed = `${original} (e2e)`;
    await displayName.fill(changed);

    // Switching mode while dirty asks first; declining keeps the edit.
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("tab").first().click();
    await expect(page).toHaveURL(/mode=yaml/);
    await expect(displayName).toHaveValue(changed);

    await page.getByRole("button", { name: "Draft 저장" }).click();
    await page.waitForURL(/\/templates\/web-app$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(changed);

    // Restore.
    await openDraftEditor(page);
    await page.getByPlaceholder("표시 이름").fill(original);
    await page.getByRole("button", { name: "Draft 저장" }).click();
    await page.waitForURL(/\/templates\/web-app$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(original);
  });
});
