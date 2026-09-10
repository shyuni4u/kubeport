import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { LogoutConfirm } from "./LogoutConfirm";
import ko from "@/messages/ko.json";

const assign = vi.fn();
let realLocation: Location;

beforeEach(() => {
  // jsdom's window.location is not writable and vi.stubGlobal does not reach
  // it, so replace the descriptor for the duration of the test.
  realLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...realLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
  assign.mockReset();
  vi.unstubAllGlobals();
});

// A factory, not a promise: building a rejected promise up front makes it
// unhandled until fetch is actually called.
function stubFetch(make: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(make));
}

const clickConfirm = () =>
  userEvent.click(screen.getByRole("button", { name: ko.logout.confirm }));

describe("LogoutConfirm", () => {
  // The route answers 303, and `redirect: "manual"` is what keeps that answer
  // readable — the default would follow it and report the LANDING page's
  // status instead, so "did the logout work?" would depend on whether landing
  // rendered. Response.ok is false for a 303, which is exactly the trap.
  it("logs out with a POST, which is what carries the Origin the route checks", async () => {
    stubFetch(async () => new Response(null, { status: 303 }));
    render(<LogoutConfirm />);

    await clickConfirm();

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(fetch).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
      redirect: "manual",
    });
  });

  // What a browser actually produces for that 303 under redirect: "manual".
  it("treats an opaque redirect as the success it is", async () => {
    stubFetch(async () => {
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, "type", { value: "opaqueredirect" });
      Object.defineProperty(res, "status", { value: 0 });
      return res;
    });
    render(<LogoutConfirm />);

    await clickConfirm();

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // The failure this screen exists to prevent. Navigating away regardless of
  // the response showed a still-signed-in user the signed-out landing page —
  // on a shared machine that is the worst way to be wrong, and a 403 here is a
  // real configuration outcome (allowedOrigins comes from PUBLIC_ORIGIN /
  // OIDC_REDIRECT_URI, so a changed domain refuses every logout).
  it("stays put and says so when the logout is refused", async () => {
    stubFetch(async () => new Response("cross-origin request rejected", { status: 403 }));
    render(<LogoutConfirm />);

    await clickConfirm();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(ko.logout.failed));
    expect(assign).not.toHaveBeenCalled();
  });

  it("does the same when the request never lands", async () => {
    stubFetch(async () => {
      throw new Error("offline");
    });
    render(<LogoutConfirm />);

    await clickConfirm();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(ko.logout.failed));
    expect(assign).not.toHaveBeenCalled();
  });

  it("lets the user try again after a failure", async () => {
    stubFetch(async () => {
      throw new Error("offline");
    });
    render(<LogoutConfirm />);

    await clickConfirm();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: ko.logout.confirm })).toBeEnabled();
  });
});
