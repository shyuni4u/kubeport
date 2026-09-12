import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { BottomBar, UnsavedChangesStatus } from "./BottomBar";
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

  it("says why save is off, and ties the reason to the button", () => {
    renderBar({ canSave: false, blockedReason: "오류 1건을 고쳐야 저장할 수 있습니다." });
    const save = screen.getByRole("button", { name: "Draft 저장" });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription("오류 1건을 고쳐야 저장할 수 있습니다.");
  });

  it("shows no reason when none is given", () => {
    renderBar();
    expect(screen.getByRole("button", { name: "Draft 저장" })).not.toHaveAttribute("aria-describedby");
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

  // A live region announces changes to its content, not its arrival: one that
  // mounted with the text, or was swapped for a new node, would say nothing.
  it("keeps one status region while edits start and a save clears them", () => {
    const bar = (dirty: boolean) => (
      <NextIntlClientProvider locale="ko" messages={ko}>
        <BottomBar canSave canPublish={false} dirty={dirty} onSave={() => {}} onPublish={() => {}} />
      </NextIntlClientProvider>
    );
    const { rerender } = render(bar(false));
    const region = screen.getByRole("status");
    const save = screen.getByRole("button", { name: "Draft 저장" });

    rerender(bar(true));
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("저장하지 않은 변경 사항이 있습니다");
    expect(save).toHaveAttribute("data-variant", "default");

    rerender(bar(false));
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toBeEmptyDOMElement();
    expect(save).toHaveAttribute("data-variant", "outline");
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

// The YAML version editor keeps its own "save as new version" button and uses
// the status on its own.
describe("UnsavedChangesStatus", () => {
  it("fills and empties the same region as the dirty flag changes", () => {
    const status = (dirty: boolean) => (
      <NextIntlClientProvider locale="ko" messages={ko}>
        <UnsavedChangesStatus dirty={dirty} />
      </NextIntlClientProvider>
    );
    const { rerender } = render(status(true));
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("저장하지 않은 변경 사항이 있습니다");
    rerender(status(false));
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toBeEmptyDOMElement();
  });
});
