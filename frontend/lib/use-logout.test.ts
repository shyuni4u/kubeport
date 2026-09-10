import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const requestLogout = vi.fn<() => Promise<boolean>>();
vi.mock("./logout", () => ({ requestLogout: () => requestLogout() }));

import { useLogout } from "./use-logout";

const assign = vi.fn();
let realLocation: Location;

beforeEach(() => {
  // jsdom's window.location is not writable; swap the descriptor per test.
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
  requestLogout.mockReset();
});

// #166 — the top-bar menu navigated to "/" whatever the logout answered, so a
// refused logout looked exactly like a successful one while the session lived
// on. Worst on a shared machine.
describe("useLogout", () => {
  it("leaves for the landing page once the logout succeeded", async () => {
    requestLogout.mockResolvedValue(true);
    const { result } = renderHook(() => useLogout());

    await act(() => result.current.logout());

    expect(assign).toHaveBeenCalledWith("/");
    expect(result.current.failed).toBe(false);
  });

  it("stays and reports a failed logout instead of pretending", async () => {
    requestLogout.mockResolvedValue(false);
    const { result } = renderHook(() => useLogout());

    await act(() => result.current.logout());

    expect(assign).not.toHaveBeenCalled();
    expect(result.current.failed).toBe(true);
    expect(result.current.pending).toBe(false);
  });

  it("clears the failure on dismiss and on a fresh attempt", async () => {
    requestLogout.mockResolvedValue(false);
    const { result } = renderHook(() => useLogout());
    await act(() => result.current.logout());
    expect(result.current.failed).toBe(true);

    act(() => result.current.dismiss());
    expect(result.current.failed).toBe(false);

    requestLogout.mockResolvedValue(true);
    await act(() => result.current.logout());
    expect(result.current.failed).toBe(false);
    expect(assign).toHaveBeenCalledWith("/");
  });
});
