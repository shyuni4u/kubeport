import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { LogsPanel } from "./LogsPanel";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

beforeAll(() => {
  // jsdom has no EventSource; the panel opens one on mount.
  // @ts-expect-error — minimal shape used by the component.
  global.EventSource = class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
  };
});

// #260 — with the terms switch on, the overview said "Pods" while the logs
// tab's picker still said "전체 인스턴스".
describe("LogsPanel instance picker and the terms switch", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
  });

  it("says 전체 인스턴스 by default", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("전체 인스턴스");
  });

  it("says All Pods with Kubernetes terms on", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("All Pods");
  });
});
