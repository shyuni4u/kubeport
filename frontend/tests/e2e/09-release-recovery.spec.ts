import { test, expect, adminStorage, demoUserStorage, autoAcceptDialogs } from "./fixtures";
import { recoveryHarness } from "./recovery-harness";

test("real cluster outage, log RBAC denial, missing resources and admin cleanup", async ({ browser, baseURL }) => {
  test.skip(process.env.KBP_RECOVERY_E2E !== "1", "Opt in with KBP_RECOVERY_E2E=1 on the disposable local kind stack");
  test.setTimeout(240_000);
  const harness = recoveryHarness(baseURL!);
  const admin = await browser.newContext({ baseURL, storageState: await adminStorage() });
  const user = await browser.newContext({ baseURL, storageState: await demoUserStorage() });
  let releaseID: string | undefined;
  try {
    const registration = await harness.start();
    const registered = await admin.request.post("/api/v1/clusters", { data: registration });
    expect(registered.status(), await registered.text()).toBe(201);
    harness.registered((await registered.json()).id);
    const created = await user.request.post("/api/v1/releases", { data: {
      template: "web-app", version: 1, cluster: registration.name,
      namespace: harness.namespace, name: harness.namespace, values: {},
    } });
    expect(created.status(), await created.text()).toBe(201);
    releaseID = (await created.json()).id;
    const path = `/api/v1/releases/${releaseID}`;
    const page = await user.newPage();
    const status = async () => {
      const response = await user.request.get(path);
      expect(response.status()).toBe(200);
      return (await response.json()).status;
    };
    await test.step("real workload becomes ready", async () => {
      await expect.poll(status, { timeout: 90_000 }).toBe("healthy");
      await page.goto(`/releases/${releaseID}`);
      await expect(page.getByRole("heading", { level: 1, name: harness.namespace })).toBeVisible();
    });
    await test.step("transport failure is displayed and recovers without losing the release", async () => {
      harness.disconnect();
      try {
        await expect.poll(status, { timeout: 30_000 }).toBe("cluster-unreachable");
        await page.reload();
        await expect(page.getByText("클러스터에 접근할 수 없습니다", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "강제 삭제", exact: true })).toHaveCount(0);
      } finally { harness.reconnect(); }
      await expect.poll(status, { timeout: 30_000 }).toBe("healthy");
      await page.reload();
      await expect(page.getByText("클러스터에 접근할 수 없습니다", { exact: true })).toHaveCount(0);
      expect((await (await user.request.get(path)).json()).id).toBe(releaseID);
    });
    await test.step("pods remain readable while logs produce the in-stream RBAC error", async () => {
      harness.logPermission(false);
      expect(harness.kube("auth", "can-i", "get", "pods", "--as=demo-user@demo.kubeport", "-n", harness.namespace).trim()).toBe("yes");
      await expect.poll(status).toBe("healthy");
      const stream = page.waitForResponse((response) => response.url().includes(`${path}/logs`));
      await page.goto(`/releases/${releaseID}/logs`);
      const opened = await stream;
      expect(opened.status()).toBe(200);
      expect(opened.headers()["content-type"]).toContain("text/event-stream");
      await expect(page.getByText("이 릴리스의 로그를 볼 권한이 없습니다.")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/is forbidden: User/)).toHaveCount(0);
      harness.logPermission(true);
      await page.reload();
      await expect(page.getByText(/Configuration complete; ready for start up/)).toBeVisible({ timeout: 30_000 });
    });
    await test.step("external deletion is distinguished from connectivity failure", async () => {
      harness.kube("delete", "deployment,service,configmap", "-n", harness.namespace,
        "-l", `kubeport.io/release-uid=${releaseID}`, "--wait=true", "--timeout=20s");
      await expect.poll(status, { timeout: 30_000 }).toBe("resources-missing");
      await page.goto(`/releases/${releaseID}`);
      await expect(page.getByText("클러스터에 해당 리소스가 없습니다", { exact: true })).toBeVisible();
      await expect(page.getByText("이 릴리스를 정리하려면 관리자에게 문의하세요.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "강제 삭제", exact: true })).toHaveCount(0);
      const denied = await user.request.delete(`${path}?force=true`);
      expect(denied.status()).toBe(403);
      expect((await denied.json()).title).toBe("rbac-denied");
      expect((await user.request.get(path)).status()).toBe(200);
    });
    await test.step("admin confirms force deletion and the record disappears", async () => {
      const page = await admin.newPage();
      autoAcceptDialogs(page);
      await page.goto(`/releases/${releaseID}`);
      await page.getByRole("button", { name: "강제 삭제", exact: true }).click();
      await expect(page).toHaveURL(/\/releases$/);
      expect((await admin.request.get(path)).status()).toBe(404);
      releaseID = undefined;
    });
  } finally {
    harness.reconnect();
    try {
      if (releaseID) {
        const deleted = await admin.request.delete(`/api/v1/releases/${releaseID}`);
        if (!deleted.ok() && deleted.status() !== 404) {
          const forced = await admin.request.delete(`/api/v1/releases/${releaseID}?force=true`);
          expect(forced.ok() || forced.status() === 404).toBe(true);
        }
      }
    } finally {
      await user.close();
      await admin.close();
      await harness.close();
    }
  }
});
