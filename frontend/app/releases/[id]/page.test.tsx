import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const apiFetch = vi.fn<(path: string) => Promise<Response>>();
vi.mock("@/lib/api-server", () => ({ apiFetch: (path: string) => apiFetch(path) }));

import ReleaseOverviewPage from "./page";
import ReleaseDetailLayout from "./layout";
import ReleaseLogsPage from "./logs/page";

beforeEach(() => apiFetch.mockReset());

// #374 (security review) — the id param arrives decoded. A release id is a
// UUID; a `?`, `#` or `/` in anything else would send the read to another
// route (`/releases/X%252Flogs` became GET /v1/releases/X/logs).
describe("release pages, the id in API paths", () => {
  const notIds = ["..", "x?y", "x#y", "x/logs", "X%2Flogs", "not-a-uuid"];

  it.each(notIds)("the overview refuses %j before asking the API", async (id) => {
    await expect(ReleaseOverviewPage({ params: Promise.resolve({ id }) })).rejects.toThrow("NOT_FOUND");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each(notIds)("the layout refuses %j before asking the API", async (id) => {
    await expect(
      ReleaseDetailLayout({ children: null, params: Promise.resolve({ id }) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each(notIds)("the logs page refuses %j before asking the API", async (id) => {
    await expect(
      ReleaseLogsPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("still reads a release by its UUID", async () => {
    const id = "3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f";
    apiFetch.mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(ReleaseOverviewPage({ params: Promise.resolve({ id }) })).rejects.toThrow("NOT_FOUND");
    expect(apiFetch).toHaveBeenCalledWith(`/v1/releases/${id}`);
  });
});
