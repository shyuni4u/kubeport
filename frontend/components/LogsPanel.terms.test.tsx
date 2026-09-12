import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { LogsPanel } from "./LogsPanel";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

type Listener = (e: MessageEvent) => void;
const listeners = new Map<string, Listener>();

beforeAll(() => {
  // jsdom has no EventSource; the panel opens one on mount. Keep the listeners
  // so a test can deliver the server's `end` frame.
  // @ts-expect-error — minimal shape used by the component.
  global.EventSource = class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      listeners.clear();
    }
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, fn);
    }
    close() {}
  };
});

function emitEnd() {
  const fn = listeners.get("end");
  if (!fn) throw new Error("component registered no 'end' listener");
  act(() => {
    fn({ data: JSON.stringify({ reason: "all pods stopped emitting" }) } as MessageEvent);
  });
}

// #260 — with the terms switch on, the overview said "Pods" while the logs
// tab still said "인스턴스": first in its picker, then in its own sentences.
describe("LogsPanel and the terms switch", () => {
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

  it("says the instance finished by default, and the Pod with Kubernetes terms on", () => {
    const { unmount } = render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    emitEnd();
    expect(screen.getByText(/이 인스턴스가 로그를 모두 보냈습니다/)).toBeInTheDocument();
    unmount();

    useKubeTermsStore.setState({ showKubeTerms: true });
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    emitEnd();
    expect(screen.getByText(/이 Pod가 로그를 모두 보냈습니다/)).toBeInTheDocument();
  });
});
