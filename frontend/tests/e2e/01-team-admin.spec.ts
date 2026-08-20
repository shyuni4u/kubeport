import { test, expect, adminStorage } from "./fixtures";

test.describe("team admin", () => {
  test.use({ storageState: async ({}, use) => use(await adminStorage()) });

  test("create team and add alice as editor", async ({ page }) => {
    const slug = `e2e-team-${Date.now()}`;
    await page.goto("/admin/teams");
    await page.getByPlaceholder(/slug/).fill(slug);
    await page.getByPlaceholder(/표시 이름/).fill("E2E Team");
    await page.getByRole("button", { name: "새 팀" }).click();
    // Server action + revalidatePath doesn't navigate; wait for the RSC
    // refresh to settle, then reload as a belt-and-braces so the list
    // reflects the new row before we assert on it.
    await page.waitForLoadState("networkidle");
    await page.reload();

    // Disambiguate by slug (unique per run). The <li> holds both the link
    // (display_name) and a sibling span (slug).
    const row = page.locator(`li:has-text("${slug}")`);
    await expect(row).toBeVisible();
    await row.getByRole("link").click();

    // Alice must have logged in at least once; the dex login fixture for
    // aliceStorage() would cover that, but this test doesn't call it, so
    // the backend is warmed up out-of-band by the /v1/me hit in the CI
    // setup step.
    await page.getByPlaceholder(/이메일/).fill("alice@example.com");
    await page.locator('select[name="role"]').selectOption("editor");
    await page.getByRole("button", { name: "추가" }).click();
    await page.waitForLoadState("networkidle");
    await page.reload();

    await expect(page.getByText("alice@example.com")).toBeVisible();
    // "editor" appears both as the role cell and as an <option>; match the cell.
    await expect(page.getByRole("cell", { name: "editor" })).toBeVisible();
  });
});
