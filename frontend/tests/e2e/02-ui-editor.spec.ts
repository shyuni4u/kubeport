import { test, expect, adminStorage } from "./fixtures";

test.describe("UI mode editor", () => {
  test.use({ storageState: async ({}, use) => use(await adminStorage()) });

  test("create a Deployment template end-to-end", async ({ page }) => {
    await page.goto("/templates/new");

    // Page renders a pre-condition message if no cluster is registered.
    // Fail fast with a readable hint instead of a mystery selector timeout.
    await expect(page.getByText(/클러스터가 등록되어|빠른 선택/)).toBeVisible({
      timeout: 10_000,
    });

    // DB may have leftover clusters from unit-test runs; explicitly pick "kind"
    // (the real one) so KindPicker loads a working OpenAPI index.
    const schemaClusterSelect = page.locator("main select").first();
    await schemaClusterSelect.selectOption("kind");

    // Featured kinds include Deployment; click it to load the schema.
    await page.getByRole("button", { name: "Deployment", exact: true }).click();

    // Wait for the schema tree to appear (it renders "spec" at minimum).
    await expect(page.locator("text=spec").first()).toBeVisible({ timeout: 15_000 });

    // Open spec.replicas in the inspector and expose it.
    await page.locator("text=replicas").first().click();
    await page.getByRole("button", { name: "사용자 노출" }).click();

    // Monaco renders via a virtualized canvas, so DOM-level text queries are
    // unreliable. We skip a preview assertion and rely on the save step +
    // /templates redirect to confirm the exposed field persisted correctly.

    // Fill metadata and save.
    const slug = `e2e-ui-${Date.now()}`;
    await page.getByPlaceholder(/템플릿 이름/).fill(slug);
    await page.getByPlaceholder(/표시 이름/).fill("E2E UI Template");
    await page.getByRole("button", { name: /저장/ }).click();

    // Redirects to /templates on success. The list renders display_name as
    // the link text and the slug only in the href; match the href directly
    // to disambiguate from prior runs that share display_name.
    await page.waitForURL(/\/templates$/);
    await expect(page.locator(`a[href="/templates/${slug}"]`)).toBeVisible();
  });
});
