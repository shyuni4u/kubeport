import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { ReleaseTable } from "./ReleaseTable";

describe("ReleaseTable", () => {
  it("renders empty-state message when no rows", () => {
    render(<ReleaseTable rows={[]} />);
    expect(screen.getByText("아직 배포된 릴리스가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders a row per release without a status column", () => {
    render(
      <ReleaseTable
        rows={[
          {
            id: "r1",
            name: "web-prod",
            template_name: "web",
            template_version: 1,
            namespace: "default",
          },
          {
            id: "r2",
            name: "web-staging",
            template_name: "web",
            template_version: 2,
            namespace: "staging",
          },
        ]}
      />,
    );
    const link1 = screen.getByRole("link", { name: "web-prod" });
    expect(link1).toHaveAttribute("href", "/releases/r1");
    expect(screen.getByText("web@v1")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    // 상태 column removed: no header, no "unknown" fallback leaking in.
    expect(screen.queryByText("상태")).toBeNull();
    expect(screen.queryByText("unknown")).toBeNull();
  });
});
