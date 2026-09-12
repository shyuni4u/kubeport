import { describe, it, expect } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { KubeTermsProvider } from "./KubeTermsProvider";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

function Probe({ id = "probe" }: { id?: string }) {
  const show = useKubeTermsStore((s) => s.showKubeTerms);
  const toggle = useKubeTermsStore((s) => s.toggle);
  return (
    <button type="button" data-testid={id} onClick={toggle}>
      {show ? "raw" : "plain"}
    </button>
  );
}

// #247 — an admin who reloaded saw plain words first and raw terms only after
// hydration, because the server rendered from a store that knew no role.
describe("KubeTermsProvider", () => {
  it("renders the role's words in the server's HTML, before any effect runs", () => {
    expect(
      renderToString(
        <KubeTermsProvider isAdmin>
          <Probe />
        </KubeTermsProvider>,
      ),
    ).toContain("raw");
    expect(
      renderToString(
        <KubeTermsProvider isAdmin={false}>
          <Probe />
        </KubeTermsProvider>,
      ),
    ).toContain("plain");
  });

  // On the server one module store would be shared by every request.
  it("gives each render tree its own store, so one viewer's role never reaches another", () => {
    render(
      <>
        <KubeTermsProvider isAdmin>
          <Probe id="admin" />
        </KubeTermsProvider>
        <KubeTermsProvider isAdmin={false}>
          <Probe id="user" />
        </KubeTermsProvider>
      </>,
    );
    expect(screen.getByTestId("admin")).toHaveTextContent("raw");
    expect(screen.getByTestId("user")).toHaveTextContent("plain");
    act(() => screen.getByTestId("admin").click());
    expect(screen.getByTestId("admin")).toHaveTextContent("plain");
    expect(screen.getByTestId("user")).toHaveTextContent("plain");
  });

  it("keeps the viewer's choice when the shell re-renders, even with another role", () => {
    const tree = (isAdmin: boolean) => (
      <KubeTermsProvider isAdmin={isAdmin}>
        <Probe />
      </KubeTermsProvider>
    );
    const { rerender } = render(tree(true));
    act(() => screen.getByTestId("probe").click());
    expect(screen.getByTestId("probe")).toHaveTextContent("plain");
    rerender(tree(true));
    expect(screen.getByTestId("probe")).toHaveTextContent("plain");
    rerender(tree(false));
    rerender(tree(true));
    expect(screen.getByTestId("probe")).toHaveTextContent("plain");
  });

  it("moves the starting value with the role until the viewer chooses", () => {
    const tree = (isAdmin: boolean) => (
      <KubeTermsProvider isAdmin={isAdmin}>
        <Probe />
      </KubeTermsProvider>
    );
    const { rerender } = render(tree(false));
    expect(screen.getByTestId("probe")).toHaveTextContent("plain");
    rerender(tree(true));
    expect(screen.getByTestId("probe")).toHaveTextContent("raw");
  });

  it("leaves the module store that single-component tests use alone", () => {
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
    render(
      <KubeTermsProvider isAdmin>
        <Probe />
      </KubeTermsProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("raw");
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(false);
  });
});
