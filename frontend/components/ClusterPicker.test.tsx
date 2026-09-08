import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ClusterPicker } from "./ClusterPicker";
import ko from "@/messages/ko.json";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

describe("ClusterPicker", () => {
  beforeEach(() => {
    refresh.mockClear();
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ clusters: [{ name: "a" }, { name: "b" }] }))),
    );
  });

  it("labels the select and refreshes the router (no full reload) on pick", async () => {
    render(
      <NextIntlClientProvider locale="ko" messages={ko}>
        <ClusterPicker />
      </NextIntlClientProvider>,
    );
    const select = await screen.findByLabelText("현재 클러스터");
    expect(select).toHaveAttribute("id", "kbp-cluster");
    fireEvent.change(select, { target: { value: "b" } });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(localStorage.getItem("kbp_cluster")).toBe("b");
  });
});
