import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ReleaseProblems, groupProblems } from "./ReleaseProblems";
import type { Instance } from "./InstancesTable";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

const pulling: Instance = {
  name: "web-1",
  phase: "Pending",
  ready: false,
  restarts: 0,
  reason: "ImagePullBackOff",
  message: 'Back-off pulling image "ghcr.io/does-not-exist/web:0.0.0"',
};

const pod = (name: string, reason?: string): Instance => ({
  name,
  phase: "Pending",
  ready: false,
  restarts: 0,
  reason,
});

describe("ReleaseProblems", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false });
  });

  it("renders nothing when no instance has a reason", () => {
    render(
      <ReleaseProblems
        releaseId="r1"
        template="web-app"
        instances={[{ name: "web-1", phase: "Running", ready: true, restarts: 0 }]}
      />,
    );
    expect(screen.queryByRole("heading", { name: "무슨 일이 있었나요" })).toBeNull();
  });

  // #33 — a release that could not pull its image said "리소스 없음" or
  // "주의" and nothing about the image.
  it("says what happened and what to do, once per cause", () => {
    render(
      <ReleaseProblems
        releaseId="r1"
        template="web-app"
        instances={[pulling, { ...pulling, name: "web-2" }]}
      />,
    );
    expect(screen.getByRole("heading", { name: "무슨 일이 있었나요" })).toBeInTheDocument();
    expect(screen.getByText("이미지를 받아오지 못했습니다 (인스턴스 2개).")).toBeInTheDocument();
    expect(screen.getByText(/이미지 이름과 태그/)).toBeInTheDocument();
    expect(screen.queryByText(/ghcr\.io/)).toBeNull();
  });

  it("shows k8s's own words only when raw terms are on", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    render(<ReleaseProblems releaseId="r1" template="web-app" instances={[pulling]} />);
    expect(
      screen.getByText(/^ImagePullBackOff — web-1: Back-off pulling image "ghcr\.io\/does-not-exist\/web:0\.0\.0"$/),
    ).toBeInTheDocument();
  });

  it("offers to change settings for a cause a new value fixes", () => {
    render(<ReleaseProblems releaseId="r1" template="web-app" instances={[pulling]} />);
    expect(screen.getByRole("link", { name: /설정을 바꿔 다시 배포/ })).toHaveAttribute(
      "href",
      "/catalog/web-app/deploy?updateReleaseId=r1",
    );
  });

  it("does not offer a redeploy while waiting for room in the cluster", () => {
    render(
      <ReleaseProblems releaseId="r1" template="web-app" instances={[pod("web-1", "Unschedulable")]} />,
    );
    expect(screen.getByText(/띄울 자리가 없어 기다리는 중/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("names a reason it cannot explain instead of dropping it", () => {
    render(
      <ReleaseProblems releaseId="r1" template="web-app" instances={[pod("web-1", "RunContainerError")]} />,
    );
    expect(
      screen.getByText("정상적으로 실행되지 않고 있습니다: RunContainerError (인스턴스 1개)."),
    ).toBeInTheDocument();
  });

  it("groups by cause in order of first appearance", () => {
    const groups = groupProblems([
      pod("a", "OOMKilled"),
      pulling,
      pod("b"),
      pod("c", "CrashLoopBackOff"),
      pod("d", "Error"),
    ]);
    expect(groups.map((g) => g.cause)).toEqual(["memory", "image", "crash"]);
    expect(groups[2]).toMatchObject({ count: 2, reasons: ["CrashLoopBackOff", "Error"] });
    expect(groups[1].detail).toBe('web-1: Back-off pulling image "ghcr.io/does-not-exist/web:0.0.0"');
  });
});
