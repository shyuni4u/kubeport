import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmSubmit } from "./ConfirmSubmit";

describe("ConfirmSubmit", () => {
  it("cancels the submit when the user declines the confirm dialog", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ConfirmSubmit message="really?">삭제</ConfirmSubmit>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits when the user confirms and is not marked busy at rest", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ConfirmSubmit message="really?">삭제</ConfirmSubmit>
      </form>,
    );
    const btn = screen.getByRole("button", { name: "삭제" });
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "false");
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
