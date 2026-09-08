import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionForm, type ActionState } from "./ActionForm";

describe("ActionForm", () => {
  it("renders the action's error inline as an alert", async () => {
    const action = vi.fn(
      async (): Promise<ActionState> => ({ error: "권한이 없습니다." }),
    );
    render(
      <ActionForm action={action}>
        <button type="submit">실행</button>
      </ActionForm>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.submit(screen.getByRole("button", { name: "실행" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("권한이 없습니다.");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("shows nothing extra when the action succeeds", async () => {
    const action = vi.fn(async (): Promise<ActionState> => ({}));
    render(
      <ActionForm action={action}>
        <button type="submit">실행</button>
      </ActionForm>,
    );
    fireEvent.submit(screen.getByRole("button", { name: "실행" }).closest("form")!);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
