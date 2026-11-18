import { beforeEach, expect, it, vi } from "vitest";
const apiFetch = vi.fn();
vi.mock("@/lib/api-server", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/components/ReleaseTable", () => ({ ReleaseTable: () => null }));
import ReleasesPage from "./page";
beforeEach(() => apiFetch.mockReset());
it.each([401, 403, 500, 502])("surfaces HTTP %s instead of an empty list", async (status) => {
  apiFetch.mockResolvedValue(new Response("private backend detail", { status }));
  await expect(ReleasesPage()).rejects.toThrow(`GET /v1/releases failed: HTTP ${status}`);
});
it("renders a successful empty list", async () => {
  apiFetch.mockResolvedValue(Response.json({ releases: [] }));
  expect(await ReleasesPage()).toBeTruthy();
});
