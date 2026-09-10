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

const panel = (instances: Instance[], tone?: "danger" | "warning") => (
  <ReleaseProblems releaseId="r1" template="web-app" version={2} instances={instances} tone={tone} />
);

describe("ReleaseProblems", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false });
  });

  // #114 — a red chip above an amber panel about the same failure left the
  // reader guessing which severity to believe.
  it("takes the danger surface when the release is in error, amber otherwise", () => {
    const { unmount } = render(panel([pulling], "danger"));
    const region = screen.getByRole("region", { name: "무슨 일이 있었나요" });
    expect(region.className).toContain("bg-destructive-surface");
    expect(region.className).not.toContain("bg-amber-50");
    unmount();

    render(panel([pod("web-1", "Unschedulable")], "warning"));
    expect(screen.getByRole("region", { name: "무슨 일이 있었나요" }).className).toContain(
      "bg-amber-50",
    );
  });

  it("renders nothing when no instance has a reason", () => {
    render(panel([{ name: "web-1", phase: "Running", ready: true, restarts: 0 }]));
    expect(screen.queryByRole("heading", { name: "무슨 일이 있었나요" })).toBeNull();
  });

  // #33 — a release that could not pull its image said "리소스 없음" or
  // "주의" and nothing about the image.
  it("says what happened and what to do, once per cause", () => {
    render(panel([pulling, { ...pulling, name: "web-2" }]));
    expect(screen.getByRole("heading", { name: "무슨 일이 있었나요" })).toBeInTheDocument();
    expect(
      screen.getByText("실행할 프로그램(이미지)을 받아오지 못했습니다 (인스턴스 2개)."),
    ).toBeInTheDocument();
    expect(screen.getByText(/프로그램 이름이나 버전을 적는 칸/)).toBeInTheDocument();
    expect(screen.queryByText(/ghcr\.io/)).toBeNull();
  });

  it("shows k8s's own words only when raw terms are on", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    render(panel([pulling]));
    expect(
      screen.getByText(/^ImagePullBackOff — web-1: Back-off pulling image "ghcr\.io\/does-not-exist\/web:0\.0\.0"$/),
    ).toBeInTheDocument();
  });

  // The unpinned /catalog/<t>/deploy route ignores the release's values, so
  // "change the one wrong setting" would open a form reset to the template's
  // defaults, on whatever version is current.
  it("links to the version-pinned update form, which loads the release's values", () => {
    render(panel([pulling]));
    expect(screen.getByRole("link", { name: /설정을 바꿔 다시 배포/ })).toHaveAttribute(
      "href",
      "/catalog/web-app/versions/2/deploy?updateReleaseId=r1",
    );
  });

  it("does not offer a redeploy while waiting for room in the cluster", () => {
    render(panel([pod("web-1", "Unschedulable")]));
    expect(screen.getByText(/띄울 자리가 없어 기다리는 중/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  // A Job with restartPolicy Never stops after an error; it is not restarting.
  it("says a container that ended with an error stopped, not that it keeps restarting", () => {
    render(panel([pod("job-1", "Error")]));
    expect(screen.getByText("실행 중 오류로 멈췄습니다 (인스턴스 1개).")).toBeInTheDocument();
    expect(screen.queryByText(/재시작/)).toBeNull();
    expect(screen.getByRole("link", { name: /설정을 바꿔 다시 배포/ })).toBeInTheDocument();
  });

  it("keeps an unexplained k8s word out of the sentence and behind the raw-terms toggle", () => {
    const { unmount } = render(panel([pod("web-1", "RunContainerError")]));
    expect(
      screen.getByText("정상적으로 실행되지 않고 있습니다 (인스턴스 1개)."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/RunContainerError/)).toBeNull();
    unmount();

    useKubeTermsStore.setState({ showKubeTerms: true });
    render(panel([pod("web-1", "RunContainerError")]));
    expect(screen.getByText("RunContainerError")).toBeInTheDocument();
  });

  it("groups by cause in order of first appearance", () => {
    const groups = groupProblems([
      pod("a", "OOMKilled"),
      pulling,
      pod("b"),
      pod("c", "CrashLoopBackOff"),
      pod("d", "Error"),
      pod("e", "CrashLoopBackOff"),
    ]);
    expect(groups.map((g) => g.cause)).toEqual(["memory", "image", "crash", "exited"]);
    expect(groups[2]).toMatchObject({ count: 2, reasons: ["CrashLoopBackOff"] });
    expect(groups[1].detail).toBe('web-1: Back-off pulling image "ghcr.io/does-not-exist/web:0.0.0"');
  });
});
