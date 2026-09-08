import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

  it("disables itself while the form action is pending (double-submit guard)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let calls = 0;
    // A form action that never resolves keeps useFormStatus().pending true.
    const action = async () => {
      calls++;
      await new Promise<void>(() => {});
    };
    render(
      <form action={action}>
        <ConfirmSubmit message="really?">게시</ConfirmSubmit>
      </form>,
    );
    const btn = screen.getByRole("button", { name: "게시" });
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveAttribute("aria-busy", "true");
    fireEvent.click(btn);
    expect(calls).toBe(1);
  });
});
