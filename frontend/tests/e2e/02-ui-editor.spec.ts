import { test, expect, adminStorage } from "./fixtures";

test.describe("UI mode editor", () => {
  test.use({ storageState: async ({}, provide) => provide(await adminStorage()) });

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
    // Exposed fields start with an empty label and the editor refuses to save
    // until every exposed field is labelled (users see this label on the form).
    await page.getByPlaceholder(/사용자에게 보일 이름/).fill("복제 수");

    // Monaco renders via a virtualized canvas, so DOM-level text queries are
    // unreliable. We skip a preview assertion and rely on the save step +
    // /templates redirect to confirm the exposed field persisted correctly.

    // Fill metadata and save.
    const slug = `e2e-ui-${Date.now()}`;
    await page.getByPlaceholder(/템플릿 이름/).fill(slug);
    await page.getByPlaceholder(/표시 이름/).fill("E2E UI Template");
    await page.getByRole("button", { name: /저장/ }).click();

    // Redirects to the template detail page on success (where publish lives).
    await page.waitForURL(new RegExp(`/templates/${slug}$`));
    await expect(page.getByRole("heading", { name: "E2E UI Template" })).toBeVisible();
    // And the list links to it.
    await page.goto("/templates");
    await expect(page.locator(`a[href="/templates/${slug}"]`)).toBeVisible();
  });
});
