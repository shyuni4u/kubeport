import { test, expect, demoUserStorage, autoAcceptDialogs } from "./fixtures";

// The non-k8s "User" persona end to end: catalog → deploy form (validation,
// RBAC feedback) → release detail → delete. Locks in the role-review fixes:
// localized zod messages, empty-name guard, RBAC sentence instead of raw
// k8s reason, and the user-facing delete button.
test.describe("demo user deploys and deletes a release", () => {
  test.use({ storageState: async ({}, provide) => provide(await demoUserStorage()) });

  test("form validation, RBAC feedback, deploy, delete", async ({ page }) => {
    autoAcceptDialogs(page);
    await page.goto("/catalog/web-app/deploy");

    const submit = page.getByRole("button", { name: "배포하기" });
    const nameInput = page.getByLabel(/배포 이름/);
    await expect(nameInput).toBeVisible();

    // Empty release name → submit disabled (no backend 400 round-trip).
    const prefilled = await nameInput.inputValue();
    await nameInput.fill("");
    await expect(submit).toBeDisabled();
    await nameInput.fill(prefilled || `e2e-user-${Date.now().toString(36)}`);

    // Welcome message has a pattern (no quotes) → Korean sentence, not "Invalid".
    const welcome = page.getByRole("textbox", { name: "환영 문구" });
    await welcome.fill('bad "quote"');
    await expect(page.getByText(/허용되지 않는 형식입니다/)).toBeVisible();
    await welcome.fill("e2e says hi");
    await expect(page.getByText(/허용되지 않는 형식입니다/)).toHaveCount(0);

    // A namespace the demo user cannot write to → plain-language denial and
    // the next step, never the raw `... is forbidden: User "..."` text.
    const namespace = page.getByLabel(/^구역/);
    await namespace.fill("kube-system");
    await expect(page.getByText(/관리자에게 '이 클러스터·구역에 배포 권한' 을 요청하세요/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/is forbidden: User/)).toHaveCount(0);
    await namespace.fill("default");
    await expect(page.getByText(/관리자에게 '이 클러스터·구역에 배포 권한'/)).toHaveCount(0, { timeout: 15_000 });

    // Deploy → release detail.
    await expect(submit).toBeEnabled();
    await submit.click();
    await page.waitForURL(/\/releases\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Undo: the user's own delete (confirm auto-accepted) → back on the list.
    await page.getByRole("button", { name: "삭제", exact: true }).click();
    await page.waitForURL(/\/releases$/, { timeout: 30_000 });
  });
});
