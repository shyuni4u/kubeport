import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ReleaseTable } from "./ReleaseTable";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

const rows = [
  { id: "r1", name: "web-prod", template_name: "web", template_version: 1, namespace: "demo" },
];

// #250 — a release deployed into a "구역" came back under a "네임스페이스"
// column. The column follows the raw-terms switch like the rest of the pages.
describe("ReleaseTable namespace column", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("calls it 구역, as the deploy form does", () => {
    render(<ReleaseTable rows={rows} />);
    expect(screen.getByRole("columnheader", { name: "구역" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "네임스페이스" })).toBeNull();
  });

  it("calls it Namespace with raw terms on", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    render(<ReleaseTable rows={rows} />);
    expect(screen.getByRole("columnheader", { name: "Namespace" })).toBeInTheDocument();
  });
});
