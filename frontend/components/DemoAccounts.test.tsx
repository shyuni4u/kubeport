import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { DemoAccounts } from "./DemoAccounts";

// Keep account names visible even though the login form now prefills them.

const accounts = [
  { label: "관리자로 체험", href: "/api/auth/login?provider=demo&hint=a", email: "demo-admin@demo.kubeport" },
  { label: "사용자로 체험", href: "/api/auth/login?provider=demo&hint=u", email: "demo-user@demo.kubeport" },
];

describe("DemoAccounts", () => {
  it("shows each account's email next to its button", () => {
    render(<DemoAccounts accounts={accounts} passwordHint="demo" />);

    expect(screen.getByText("demo-admin@demo.kubeport")).toBeInTheDocument();
    expect(screen.getByText("demo-user@demo.kubeport")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "관리자로 체험" })).toHaveAttribute(
      "href",
      accounts[0].href,
    );
    expect(screen.getByRole("link", { name: "사용자로 체험" })).toHaveAttribute(
      "href",
      accounts[1].href,
    );
  });

  it("shows the password alongside the accounts when a hint is configured", () => {
    render(<DemoAccounts accounts={accounts} passwordHint="s3cret" />);

    expect(screen.getByText(/s3cret/)).toBeInTheDocument();
  });

  // No DEMO_PASSWORD_HINT means the install chose not to print it; the emails
  // still help, and an empty "password:" line would not.
  it("leaves the password line out without a hint, and still shows the accounts", () => {
    render(<DemoAccounts accounts={accounts} passwordHint="" />);

    expect(screen.queryByText("공통 데모 비밀번호", { selector: "dt" })).toBeNull();
    expect(screen.getByText("demo-user@demo.kubeport")).toBeInTheDocument();
  });
});
