import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { MetaRow } from "./MetaRow";

// #369: a template name is one path segment in every template route. A name
// the API would refuse says so while it is typed, not as a 400 on save.
describe("MetaRow template name", () => {
  const nameMessage = /영문자·숫자·하이픈으로 쓰고/;

  it("says what a name may be when the typed one would be refused", () => {
    render(<MetaRow meta={{ name: "my/app", tags: [] }} onChange={vi.fn()} />);
    const input = screen.getByPlaceholderText("템플릿 이름 (예: web-app)");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(nameMessage)).toBeInTheDocument();
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText(nameMessage).id);
  });

  it("says nothing for a valid name, or before one is typed", () => {
    const { rerender } = render(<MetaRow meta={{ name: "web-app", tags: [] }} onChange={vi.fn()} />);
    expect(screen.queryByText(nameMessage)).not.toBeInTheDocument();
    rerender(<MetaRow meta={{ name: "", tags: [] }} onChange={vi.fn()} />);
    expect(screen.queryByText(nameMessage)).not.toBeInTheDocument();
  });

  // An existing template's name cannot change, and one from before the rule
  // still works: flagging it would only alarm.
  it("does not flag a locked name", () => {
    render(<MetaRow meta={{ name: "old_name", tags: [] }} onChange={vi.fn()} nameLocked />);
    expect(screen.queryByText(nameMessage)).not.toBeInTheDocument();
  });
});
