import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { SidebarBody } from "./SidebarBody";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

async function renderBody(signedIn: boolean) {
  const body = await SidebarBody({ role: "user", signedIn });
  return render(
    <NextIntlClientProvider locale="ko" messages={ko}>
      {body}
    </NextIntlClientProvider>,
  );
}

// #377 — the sidebar is on every page, the logged-out landing included. The
// picker used to fetch /api/v1/clusters on mount whatever the session, so a
// visitor got a 401 in the console and "no clusters registered" on screen.
// Whether there is a session is known on the server (AppShell's /v1/me), so
// the picker is not rendered at all without one: no request goes out.
describe("SidebarBody cluster picker", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ clusters: [{ name: "a" }, { name: "b" }] })));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders no picker and requests no clusters without a session", async () => {
    await renderBody(false);
    // Flush any pending effects and updates, so a mounted picker would have
    // fetched by now.
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(ko.shell.currentCluster)).not.toBeInTheDocument();
    expect(screen.queryByText(ko.shell.noClusters)).not.toBeInTheDocument();
    // The nav itself is still there. The server translations mock returns the
    // key, so the link reads "catalog".
    expect(screen.getByRole("link", { name: "catalog" })).toBeInTheDocument();
  });

  it("renders the picker, filled from /api/v1/clusters, with a session", async () => {
    await renderBody(true);
    const select = await screen.findByLabelText(ko.shell.currentCluster);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/clusters");
    expect(select).toHaveValue("a");
  });
});
