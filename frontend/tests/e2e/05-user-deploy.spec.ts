import { test, expect, demoUserStorage, autoAcceptDialogs } from "./fixtures";

// The non-k8s "User" persona end to end: catalog → deploy form (validation,
// RBAC feedback) → release detail → delete. Locks in the role-review fixes:
// localized zod messages, empty-name guard, RBAC sentence instead of raw
// k8s reason, and the user-facing delete button.
test.describe("demo user deploys and deletes a release", () => {
  test.use({ storageState: async ({}, provide) => provide(await demoUserStorage()) });

  // #161: CI retries this spec, and an attempt that deployed and then timed out
  // leaves its release behind. With the ownership check, the retry's deploy of
  // the same fixed-name template into the same namespace is a 409 rather than
  // the silent takeover that used to let it pass. So each attempt starts
  // without web-app releases in `default` — this is the only spec that makes
  // them, and a demo account lists only demo-owned releases.
  test.beforeEach(async ({ page }) => {
    const res = await page.request.get("/api/v1/releases");
    if (!res.ok()) return;
    const { releases = [] } = (await res.json()) as {
      releases?: Array<{ id: string; template_name?: string; namespace?: string }>;
    };
    for (const r of releases) {
      if (r.template_name === "web-app" && r.namespace === "default") {
        await page.request.delete(`/api/v1/releases/${r.id}`);
      }
    }
  });

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
    // #30 — once the denial is definite the button must be unclickable, not
    // just accompanied by a warning. This is the only frontend suite CI runs,
    // so without this assertion the regression has no backstop.
    await expect(submit).toBeDisabled();
    await expect(
      page.getByText(
        "권한이 없어 지금은 배포할 수 없습니다. '권한 확인' 안내를 확인한 뒤 관리자에게 요청하세요.",
      ),
    ).toBeVisible();

    // #43 — the slider track must not be the page background colour.
    const track = page.locator('[data-slot="slider-track"]').first();
    const [trackBg, pageBg] = await Promise.all([
      track.evaluate((el) => getComputedStyle(el).backgroundColor),
      page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    ]);
    expect(trackBg).not.toBe(pageBg);

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
