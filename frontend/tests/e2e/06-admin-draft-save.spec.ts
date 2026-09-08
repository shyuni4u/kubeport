import { test, expect, demoAdminStorage } from "./fixtures";

// Admin persona on the seeded `web-app` draft in its native YAML mode:
// edit the ui-spec in Monaco, verify the unsaved-edits guard on tab switch,
// save (a YAML draft is PATCHed in place — the BFF proxy bug from PR #7),
// land on the detail page, and confirm the edit persisted.
test.describe("demo admin edits the seeded draft", () => {
  test.use({ storageState: async ({}, provide) => provide(await demoAdminStorage()) });

  const MARKER = "# e2e-touched";

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
    // Two Monaco editors: resources.yaml, ui-spec.yaml.
    await expect(page.locator(".monaco-editor").nth(1)).toBeVisible({ timeout: 20_000 });
  }

  test("unsaved-edits guard, PATCH save, edit persists", async ({ page }) => {
    await openDraftEditor(page);

    // Append a harmless comment to ui-spec.yaml via the editor itself.
    const uiSpecEditor = page.locator(".monaco-editor").nth(1);
    await uiSpecEditor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("End");
    await page.keyboard.type(`\n${MARKER}`);
    await expect(uiSpecEditor.getByText(MARKER)).toBeVisible();

    // Switching mode while dirty asks first; declining keeps us here.
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("tab", { name: /UI 모드|UI mode/ }).click();
    await expect(page).toHaveURL(/mode=yaml/);
    await expect(uiSpecEditor.getByText(MARKER)).toBeVisible();

    await page.getByRole("button", { name: /^(저장|Save)$/ }).click();
    await page.waitForURL(/\/templates\/web-app$/, { timeout: 30_000 });

    // Reopen: the PATCHed draft carries the marker.
    await openDraftEditor(page);
    await expect(page.locator(".monaco-editor").nth(1).getByText(MARKER)).toBeVisible({ timeout: 10_000 });
  });
});
