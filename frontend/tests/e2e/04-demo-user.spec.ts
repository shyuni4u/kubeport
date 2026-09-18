import { test, expect, demoUserStorage, demoAdminStorage } from "./fixtures";

test.describe("demo user", () => {
  test.use({ storageState: async ({}, provide) => provide(await demoUserStorage()) });

  test("sees the demo banner and the seeded catalog", async ({ page }) => {
    await page.goto("/catalog");
    await expect(page.getByRole("status")).toContainText(/데모 세션|Demo session/);
    await expect(page.getByText("웹 앱")).toBeVisible();
    await expect(page.getByText("야간 배치")).toBeVisible();
  });

  test("landing shows operational status when logged in", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /배포 운영 현황|Deployment operations/ })).toBeVisible();
    await expect(page.locator('aside a[href="/clusters"]')).toHaveCount(0);
    await expect(page.locator('aside a[href="/storage"], aside a[href="/network"]')).toHaveCount(0);
  });
});

test.describe("demo admin restrictions", () => {
  test.use({ storageState: async ({}, provide) => provide(await demoAdminStorage()) });

  test("cannot create a team", async ({ page, request }) => {
    const res = await request.post("/api/v1/teams", { data: { name: "should-fail", display_name: "x" } });
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain("demo-restricted");
  });

  test("opens beta operations inside the selected cluster", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /클러스터 설정 beta|Cluster settings beta/ }).click();
    const nav = page.getByRole("navigation", { name: /선택한 클러스터의 운영 메뉴|Selected cluster operations/ });
    const storage = nav.getByRole("link", { name: /스토리지 beta|Storage beta/ });
    const href = await storage.getAttribute("href");
    expect(href).toMatch(/^\/clusters\/[^/]+\/storage$/);
    await storage.click();
    await page.waitForURL(`**${href}`);
    await expect(nav.getByRole("link", { name: /스토리지 beta|Storage beta/ })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: /노드 운영 beta|Node operations beta/ })).toHaveAttribute("href", href!.replace(/storage$/, "nodes"));
    await expect(page.locator('aside a[href="/nodes"], aside a[href="/storage"], aside a[href="/network"]')).toHaveCount(0);
  });
});

test.describe("logged out landing", () => {
  for (const [role, email] of [
    [/관리자로 체험|Try as admin/, "demo-admin@demo.kubeport"],
    [/사용자로 체험|Try as user/, "demo-user@demo.kubeport"],
  ] as const) {
    test(`prefills ${email} and focuses the password`, async ({ browser }) => {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      try {
        const page = await ctx.newPage();
        await page.goto("/");
        await page.getByRole("link", { name: role }).click();
        await expect(page.locator("input[name=login]")).toHaveValue(email);
        await expect(page.locator("input[name=password]")).toBeFocused();
        await expect(page.locator("input[name=password]")).toHaveValue("");
      } finally {
        await ctx.close();
      }
    });
  }

  test("shows demo entry buttons", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByRole("link", { name: /관리자로 체험|Try as admin/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /사용자로 체험|Try as user/ })).toBeVisible();
    await expect(page.locator('aside a[href="/clusters"], aside a[href="/storage"], aside a[href="/network"], aside a[href="/catalog"]')).toHaveCount(0);
    await ctx.close();
  });
});
