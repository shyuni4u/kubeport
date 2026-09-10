import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ReleaseTable } from "./ReleaseTable";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

const rows = [
  { id: "r1", name: "web-prod", template_name: "web", template_version: 1, namespace: "demo" },
];

// #250 — a release deployed into a "구역" came back under a "네임스페이스"
// column. The list page has no terms switch, so the column does not follow
// one: following it named the column after whichever page the reader came
// from (review of #250).
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

  it("keeps the same name when raw terms were turned on elsewhere", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    render(<ReleaseTable rows={rows} />);
    expect(screen.getByRole("columnheader", { name: "구역" })).toBeInTheDocument();
  });
});
