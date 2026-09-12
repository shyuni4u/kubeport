import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { BottomBar } from "./BottomBar";
import ko from "@/messages/ko.json";

function renderBar(props: Partial<React.ComponentProps<typeof BottomBar>> = {}) {
  const onSave = vi.fn();
  const onPublish = vi.fn();
  render(
    <NextIntlClientProvider locale="ko" messages={ko}>
      <BottomBar canSave canPublish={false} onSave={onSave} onPublish={onPublish} {...props} />
    </NextIntlClientProvider>,
  );
  return { onSave, onPublish };
}

describe("BottomBar", () => {
  it("shows the publish-from-detail hint instead of a dead Publish button", () => {
    const { onSave } = renderBar();
    expect(screen.getByText("게시는 저장 후 템플릿 상세 페이지에서 합니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "게시" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Draft 저장" }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("renders the Publish button only when publishing is possible", () => {
    const { onPublish } = renderBar({ canPublish: true });
    expect(screen.queryByText("게시는 저장 후 템플릿 상세 페이지에서 합니다.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "게시" }));
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it("shows busy labels and disables buttons while saving / publishing", () => {
    renderBar({ canPublish: true, saving: true, publishing: true });
    expect(screen.getByRole("button", { name: "저장 중…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "게시 중…" })).toBeDisabled();
  });

  // #146 — with edits pending, nothing on screen said so until the browser's
  // leave prompt did.
  it("says there are unsaved changes, in a live region, only while dirty", () => {
    renderBar({ dirty: true });
    expect(screen.getByRole("status")).toHaveTextContent("저장하지 않은 변경 사항이 있습니다");
  });

  it("keeps the status region mounted but empty when there is nothing to save", () => {
    renderBar({ dirty: false });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("gives Save the primary look only while dirty, and keeps it enabled either way", () => {
    renderBar({ dirty: false });
    const idle = screen.getByRole("button", { name: "Draft 저장" });
    expect(idle).toBeEnabled();
    expect(idle).toHaveAttribute("data-variant", "outline");
  });

  it("switches Save to the primary look when edits are pending", () => {
    renderBar({ dirty: true });
    expect(screen.getByRole("button", { name: "Draft 저장" })).toHaveAttribute("data-variant", "default");
  });
});
