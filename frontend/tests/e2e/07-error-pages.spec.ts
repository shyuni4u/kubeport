import { test, expect, demoUserStorage } from "./fixtures";

// Missing or inaccessible things must land on our localized not-found page,
// never on Next's default "404 | This page could not be found."
test.describe("error pages", () => {
  test.use({ storageState: async ({}, provide) => provide(await demoUserStorage()) });

  const NOT_FOUND = /찾을 수 없거나 볼 권한이 없습니다|Not found, or you don't have access/;
  const NEXT_DEFAULT = /This page could not be found/;

  test("unknown template", async ({ page }) => {
    await page.goto("/templates/does-not-exist-e2e");
    await expect(page.getByText(NOT_FOUND)).toBeVisible();
    await expect(page.getByText(NEXT_DEFAULT)).toHaveCount(0);
  });

  test("unknown release", async ({ page }) => {
    await page.goto("/releases/00000000-0000-0000-0000-000000000000");
    await expect(page.getByText(NOT_FOUND)).toBeVisible();
    await expect(page.getByText(NEXT_DEFAULT)).toHaveCount(0);
  });

  test("unknown team (non-admin) never shows a Next default screen", async ({ page }) => {
    // A regular user hitting an admin route gets our localized not-found
    // (404) or the generic error page (403 → error.tsx) — either is ours.
    await page.goto("/admin/teams/00000000-0000-0000-0000-000000000000");
    await expect(page.getByText(/찾을 수 없거나 볼 권한이 없습니다|문제가 발생했습니다|Not found, or you don't have access|Something went wrong/)).toBeVisible();
    await expect(page.getByText(NEXT_DEFAULT)).toHaveCount(0);
    await expect(page.getByText(/Application error/)).toHaveCount(0);
  });

  test("not-found page offers a way back", async ({ page }) => {
    await page.goto("/templates/does-not-exist-e2e");
    await page.getByRole("link", { name: /처음으로 돌아가기|Back to start/ }).click();
    await page.waitForURL(/\/(catalog)?$/);
  });
});
