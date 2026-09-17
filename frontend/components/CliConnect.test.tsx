import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl } from "@/tests/intl-test-utils";
import { CliConnect } from "./CliConnect";

afterEach(() => vi.unstubAllGlobals());

describe("CLI connection consent", () => {
  it("explains write permissions and does not issue a token on page load", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    renderWithIntl(<CliConnect />);
    expect(screen.getByText(/생성·변경·삭제/)).toBeInTheDocument();
    expect(screen.getByText(/CLI logout은 로컬 사본만/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("issues on click, hides the token and copies only after a separate click", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "test-credential", expires_at: "2026-09-17T12:00:00Z" })));
    vi.stubGlobal("fetch", fetch);
    renderWithIntl(<CliConnect />);
    fireEvent.click(screen.getByRole("button", { name: "연결 토큰 발급" }));
    const field = await screen.findByLabelText("연결 토큰");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveValue("test-credential");
    expect(fetch).toHaveBeenCalledWith("/api/auth/cli-token", { method: "POST", redirect: "error" });
    expect(copy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "토큰 복사" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("test-credential"));
    expect(await screen.findByRole("button", { name: "복사됨" })).toBeInTheDocument();
  });
  it("reports expired sessions and allows another attempt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    renderWithIntl(<CliConnect />);
    fireEvent.click(screen.getByRole("button", { name: "연결 토큰 발급" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("다시 로그인");
    expect(screen.getByRole("button", { name: "연결 토큰 발급" })).toBeEnabled();
    expect(screen.queryByLabelText("연결 토큰")).not.toBeInTheDocument();
  });
});
