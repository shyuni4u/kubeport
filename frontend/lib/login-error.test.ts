import { describe, expect, it } from "vitest";

import { loginErrorFromIdp, parseLoginError } from "./login-error";

describe("loginErrorFromIdp", () => {
  // The user pressed "cancel" on the consent screen, or the IdP wants an
  // interaction we can't do on a callback. Either way: nothing broke, they
  // just need to start over.
  it.each(["access_denied", "consent_required", "interaction_required", "login_required"])(
    "maps %s to cancelled",
    (code) => {
      expect(loginErrorFromIdp(code)).toBe("cancelled");
    },
  );

  it.each(["server_error", "temporarily_unavailable", "invalid_request", "weird_new_code"])(
    "maps %s to failed",
    (code) => {
      expect(loginErrorFromIdp(code)).toBe("failed");
    },
  );
});

describe("parseLoginError", () => {
  it("accepts the codes we emit", () => {
    expect(parseLoginError("cancelled")).toBe("cancelled");
    expect(parseLoginError("expired")).toBe("expired");
    expect(parseLoginError("failed")).toBe("failed");
  });

  // ?login_error is in the URL, so anyone can put anything there. Unknown
  // values must not reach the translation lookup.
  it("rejects anything else", () => {
    expect(parseLoginError(null)).toBeNull();
    expect(parseLoginError(undefined)).toBeNull();
    expect(parseLoginError("")).toBeNull();
    expect(parseLoginError("<script>alert(1)</script>")).toBeNull();
    expect(parseLoginError("Cancelled")).toBeNull();
  });
});
