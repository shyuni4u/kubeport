import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/tests/intl-test-utils";
import { TeamCreateForm, TeamMemberForm } from "./TeamForms";

describe("team forms", () => {
  it("submits the entered email and selected native role, with an inline server error", async () => {
    const action = vi.fn(async () => ({ error: "이미 등록된 멤버입니다." }));
    renderWithIntl(<TeamMemberForm action={action} />);
    await userEvent.type(screen.getByRole("textbox"), "reader@example.test");
    await userEvent.selectOptions(screen.getByRole("combobox"), "viewer");
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    const data = (action.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(data.get("email")).toBe("reader@example.test");
    expect(data.get("role")).toBe("viewer");
    expect(await screen.findByRole("alert")).toHaveTextContent("이미 등록된 멤버입니다.");
    expect(screen.getByRole("textbox")).toHaveValue("reader@example.test");
  });

  it("keeps demo member controls unavailable and cannot submit", async () => {
    const action = vi.fn();
    renderWithIntl(<TeamMemberForm action={action} disabled />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("button")).toBeDisabled();
    await userEvent.click(screen.getByRole("button"));
    expect(action).not.toHaveBeenCalled();
  });

  it("keeps names and help attached after the placeholders disappear", async () => {
    renderWithIntl(<TeamCreateForm action={vi.fn()} />);
    const slug = screen.getByRole("textbox", { name: "슬러그" });
    await userEvent.type(slug, "platform");
    expect(slug).toHaveAccessibleName("슬러그");
    expect(slug).toHaveAccessibleDescription("팀을 식별하는 이름입니다. 예: platform");
    expect(screen.getByRole("textbox", { name: "표시 이름" })).toBeVisible();
  });
});
