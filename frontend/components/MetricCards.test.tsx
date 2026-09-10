import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { MetricCards } from "./MetricCards";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

describe("MetricCards", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false });
  });

  it("renders ready/total instances and restarts with friendly labels", () => {
    render(
      <MetricCards readyTotal={[2, 3]} restarts={1} memory={null} accessURL={null} />,
    );
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("준비된 인스턴스")).toBeInTheDocument();
    expect(screen.getByText("재시작")).toBeInTheDocument();
  });

  // The page never has an address to show yet, so the hint must not claim the
  // template opens none — an Ingress template's release would read a false
  // sentence about itself (#250 review).
  it("hides null metrics and says addresses are not shown yet instead of showing a dash", () => {
    render(
      <MetricCards readyTotal={[2, 3]} restarts={1} memory={null} accessURL={null} />,
    );
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    expect(screen.queryByText("메모리")).not.toBeInTheDocument();
    expect(screen.queryByText("외부 주소")).not.toBeInTheDocument();
    expect(screen.getByText(/외부 주소는 아직 이 화면에 표시하지 않습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/열지 않습니다/)).not.toBeInTheDocument();
  });

  // #250 — the card said "접근 URL" while the hint under it said "외부 주소".
  it("renders memory and accessURL when provided, in the hint's words, without the hint", () => {
    render(
      <MetricCards
        readyTotal={[1, 1]}
        restarts={0}
        memory="128Mi"
        accessURL="https://web.example.com"
      />,
    );
    expect(screen.getByText("128Mi")).toBeInTheDocument();
    expect(screen.getByText("외부 주소")).toBeInTheDocument();
    expect(screen.getByText("https://web.example.com")).toBeInTheDocument();
    expect(screen.queryByText(/표시하지 않습니다/)).not.toBeInTheDocument();
  });

  it("switches to raw k8s labels when the toggle is on", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    render(<MetricCards readyTotal={[1, 1]} restarts={0} memory="128Mi" accessURL="svc" />);
    expect(screen.getByText("Ready Pods")).toBeInTheDocument();
    expect(screen.getByText("External Address")).toBeInTheDocument();
    expect(screen.queryByText("준비된 인스턴스")).not.toBeInTheDocument();
  });
});
