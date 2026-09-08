import { test, expect, demoUserStorage, demoAdminStorage } from "./fixtures";

test.describe("demo user", () => {
  test.use({ storageState: async ({}, provide) => provide(await demoUserStorage()) });

  test("sees the demo banner and the seeded catalog", async ({ page }) => {
    await page.goto("/catalog");
    await expect(page.getByRole("status")).toContainText(/데모 세션|Demo session/);
    await expect(page.getByText("웹 앱")).toBeVisible();
    await expect(page.getByText("야간 배치")).toBeVisible();
  });

  test("landing shows 'go to catalog' when logged in", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /카탈로그로 이동|Go to catalog/ })).toBeVisible();
  });
});

test.describe("demo admin restrictions", () => {
  test.use({ storageState: async ({}, provide) => provide(await demoAdminStorage()) });

  test("cannot create a team", async ({ page, request }) => {
    const res = await request.post("/api/v1/teams", { data: { name: "should-fail", display_name: "x" } });
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain("demo-restricted");
  });
});

test.describe("logged out landing", () => {
  test("shows demo entry buttons", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByRole("link", { name: /관리자로 체험|Try as admin/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /사용자로 체험|Try as user/ })).toBeVisible();
    await ctx.close();
  });
});
