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
});
