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

  test("unknown team", async ({ page }) => {
    await page.goto("/admin/teams/00000000-0000-0000-0000-000000000000");
    await expect(page.getByText(NOT_FOUND)).toBeVisible();
    await expect(page.getByText(NEXT_DEFAULT)).toHaveCount(0);
  });

  test("not-found page offers a way back", async ({ page }) => {
    await page.goto("/templates/does-not-exist-e2e");
    await page.getByRole("link", { name: /처음으로 돌아가기|Back to start/ }).click();
    await page.waitForURL(/\/(catalog)?$/);
  });
});
