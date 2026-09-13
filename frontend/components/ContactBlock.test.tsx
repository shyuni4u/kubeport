import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ContactBlock } from "./ContactBlock";

afterEach(() => vi.restoreAllMocks());

describe("ContactBlock", () => {
  it("lists the labelled values, skipping empty ones", () => {
    render(
      <ContactBlock
        facts={[
          ["릴리스 ID", "rel-1"],
          ["클러스터", "oci-a1"],
          ["비어 있음", ""],
        ]}
      />,
    );
    const block = screen.getByText(/릴리스 ID: rel-1/);
    expect(block).toHaveTextContent("클러스터: oci-a1");
    expect(block).not.toHaveTextContent("비어 있음");
    expect(screen.getByText("문의할 때 이 정보를 함께 보내 주세요")).toBeInTheDocument();
  });

  it("copies exactly what it shows", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ContactBlock facts={[["릴리스 ID", "rel-1"], ["상태 판정", "cluster-unreachable"]]} />);
    fireEvent.click(screen.getByRole("button", { name: "복사" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "복사됨" })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith("릴리스 ID: rel-1\n상태 판정: cluster-unreachable");
  });

  it("stays on screen when the clipboard is unavailable", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<ContactBlock facts={[["릴리스 ID", "rel-1"]]} />);
    fireEvent.click(screen.getByRole("button", { name: "복사" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "복사" })).toBeInTheDocument());
    expect(screen.getByText(/릴리스 ID: rel-1/)).toBeInTheDocument();
  });
});
