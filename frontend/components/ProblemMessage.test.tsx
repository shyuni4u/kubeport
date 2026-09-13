import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import type { ErrorDetailLevel } from "@/lib/error-detail";
import { ErrorDetailProvider } from "./ErrorDetailProvider";
import { ProblemMessage } from "./ProblemMessage";

const forbiddenBody = JSON.stringify({
  type: "https://kubeport.io/errors/k8s-error",
  title: "k8s-error",
  status: 502,
  detail: 'deployments.apps is forbidden: User "demo-user@demo.kubeport" cannot create resource "deployments" in the namespace "default"',
  request_id: "req-abc",
});

const internalBody = JSON.stringify({
  type: "https://kubeport.io/errors/internal",
  title: "internal",
  status: 500,
  detail: "CreateRelease failed",
  request_id: "req-500",
});

function show(level: ErrorDetailLevel, status: number, body: string) {
  return render(
    <ErrorDetailProvider initial={level}>
      <ProblemMessage
        message="클러스터가 배포를 거절했습니다."
        status={status}
        body={body}
        at="2026-09-13T05:00:00.000Z"
        context={[
          ["클러스터", "oci-a1"],
          ["구역", "default"],
          ["빈 값", ""],
        ]}
      />
    </ErrorDetailProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("ProblemMessage", () => {
  it("friendly: the sentence and the copyable block, no server message or kind", () => {
    show("friendly", 502, forbiddenBody);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("클러스터가 배포를 거절했습니다.");
    expect(alert).not.toHaveTextContent("forbidden");
    expect(alert).not.toHaveTextContent("k8s-error 502");
    expect(screen.queryByText("자세히 보기")).toBeNull();
    // The block carries what an admin needs to find the request, and skips empty values.
    const block = screen.getByText(/요청 ID: req-abc/);
    expect(block).toHaveTextContent("시각: 2026-09-13T05:00:00.000Z");
    expect(block).toHaveTextContent("상태: 502 k8s-error");
    expect(block).toHaveTextContent("클러스터: oci-a1");
    expect(block).toHaveTextContent("구역: default");
    expect(block).not.toHaveTextContent("빈 값");
  });

  it("detailed: the kind and the cluster's message, folded", () => {
    show("detailed", 502, forbiddenBody);
    const details = screen.getByText("자세히 보기").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("502 k8s-error");
    expect(details).toHaveTextContent('cannot create resource "deployments" in the namespace "default"');
  });

  it("detailed leaves a 500's operation sentence out; raw shows it open with the log hint", () => {
    const { unmount } = show("detailed", 500, internalBody);
    expect(screen.getByRole("alert")).not.toHaveTextContent("CreateRelease failed");
    unmount();

    show("raw", 500, internalBody);
    const details = screen.getByText("자세히 보기").closest("details");
    expect(details).toHaveAttribute("open");
    expect(details).toHaveTextContent("CreateRelease failed");
    expect(details).toHaveTextContent("요청 ID 로");
  });

  // The 2026-09-09 note on #6: the envelope is noise, the escapes a loss.
  it("never prints the JSON envelope, even at raw", () => {
    show("raw", 502, forbiddenBody);
    const alert = screen.getByRole("alert");
    expect(alert).not.toHaveTextContent('"type"');
    expect(alert).not.toHaveTextContent("https://kubeport.io/errors/");
    expect(alert).not.toHaveTextContent('\\"');
  });

  it("shows extension members as fields at detailed", () => {
    show(
      "detailed",
      409,
      JSON.stringify({ title: "resource-conflict", status: 409, detail: "held", conflicts: [{ kind: "Service", name: "web", owner: "other" }] }),
    );
    expect(screen.getByText("자세히 보기").closest("details")).toHaveTextContent('"owner": "other"');
  });

  it("renders a hostile message as text, not markup", () => {
    show("raw", 400, JSON.stringify({ title: "validation-error", status: 400, detail: "<img src=x onerror=alert(1)>" }));
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("a body that is not a Problem still gets the sentence and the block", () => {
    show("raw", 502, "<html>bad gateway</html>");
    expect(screen.getByRole("alert")).toHaveTextContent("클러스터가 배포를 거절했습니다.");
    expect(screen.queryByText("자세히 보기")).toBeNull();
    expect(screen.getByRole("alert")).not.toHaveTextContent("bad gateway");
  });

  it("copies the block", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    show("friendly", 502, forbiddenBody);
    fireEvent.click(screen.getByRole("button", { name: "복사" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "복사됨" })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("요청 ID: req-abc"));
  });
});
