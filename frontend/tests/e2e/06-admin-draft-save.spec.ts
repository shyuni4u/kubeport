import { test, expect, demoAdminStorage } from "./fixtures";
import type { Page } from "@playwright/test";

// Admin persona on the seeded `web-app` draft in its native YAML mode:
// edit the ui-spec, verify the unsaved-edits guard on tab switch, save (a
// YAML draft is PATCHed in place — the BFF proxy bug from PR #7), land on
// the detail page, and confirm the edit persisted.
//
// Monaco renders text as tokenized spans, so we go through its model API
// (`window.monaco`, set by @monaco-editor/react's loader) instead of DOM
// text queries or synthetic typing.
test.describe("demo admin edits the seeded draft", () => {
  test.use({ storageState: async ({}, provide) => provide(await demoAdminStorage()) });

  const MARKER = "# e2e-touched";

  async function openDraftEditor(page: Page): Promise<void> {
    // Ask the API which version is the draft (the seed keeps exactly one)
    // rather than guessing from link order on the detail page.
    const res = await page.request.get("/api/v1/templates/web-app/versions");
    expect(res.ok()).toBeTruthy();
    const { versions } = (await res.json()) as { versions: Array<{ version: number; status: string }> };
    const draft = versions.find((v) => v.status === "draft");
    expect(draft, "seeded web-app draft must exist").toBeTruthy();
    await page.goto(`/templates/web-app/versions/${draft!.version}/edit?mode=yaml`);
    await expect(page.locator(".monaco-editor").nth(1)).toBeVisible({ timeout: 20_000 });
    // Wait until both models (resources.yaml, ui-spec.yaml) are populated.
    await page.waitForFunction(() => {
      const m = (window as unknown as { monaco?: MonacoLike }).monaco;
      const values = m?.editor.getModels().map((x) => x.getValue()) ?? [];
      return values.some((v) => v.includes("fields:")) && values.some((v) => v.includes("kind:"));
    }, undefined, { timeout: 20_000 });
  }

  type MonacoLike = { editor: { getModels(): Array<{ getValue(): string; setValue(v: string): void }> } };

  function uiSpecValue(page: Page): Promise<string> {
    return page.evaluate(() => {
      const m = (window as unknown as { monaco?: MonacoLike }).monaco!;
      return m.editor.getModels().map((x) => x.getValue()).find((v) => v.includes("fields:")) ?? "";
    });
  }

  test("unsaved-edits guard, PATCH save, edit persists", async ({ page }) => {
    await openDraftEditor(page);

    // Append a harmless comment to ui-spec.yaml through the model so the
    // editor's onChange (and the dirty flag) fire exactly like a keystroke.
    await page.evaluate((marker) => {
      const m = (window as unknown as { monaco?: MonacoLike }).monaco!;
      const model = m.editor.getModels().find((x) => x.getValue().includes("fields:"))!;
      model.setValue(model.getValue().replace(/\s*$/, "") + "\n" + marker + "\n");
    }, MARKER);
    expect(await uiSpecValue(page)).toContain(MARKER);

    // Switching mode while dirty asks first; declining keeps us here.
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("tab", { name: /UI 모드|UI mode/ }).click();
    await expect(page).toHaveURL(/mode=yaml/);
    expect(await uiSpecValue(page)).toContain(MARKER);

    await page.getByRole("button", { name: /^(저장|Save)$/ }).click();
    await page.waitForURL(/\/templates\/web-app$/, { timeout: 30_000 });

    // Reopen: the PATCHed draft carries the marker.
    await openDraftEditor(page);
    expect(await uiSpecValue(page)).toContain(MARKER);
  });
});
