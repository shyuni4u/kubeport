// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueCliToken, readCliToken, CLI_TOKEN_TTL_MS } from "./cli-token";

const sid = "7d84e004-432c-44c0-88cd-4e6669bc4581";
const origin = "https://my-kubeport.example";
const now = 1_800_000_000_000;
beforeEach(() => vi.stubEnv("APP_ENCRYPTION_KEY_B64", Buffer.alloc(32, 7).toString("base64")));
afterEach(() => vi.unstubAllEnvs());

describe("installation-local CLI credentials", () => {
  it("hides the browser session ID and resolves only within the lifetime", () => {
    const { token, expires_at } = issueCliToken(sid, origin, now);
    expect(Buffer.from(token.slice(8), "base64url").includes(Buffer.from(sid))).toBe(false);
    expect(readCliToken(token, origin, now)).toBe(sid);
    expect(readCliToken(token, origin, now + CLI_TOKEN_TTL_MS - 1)).toBe(sid);
    expect(readCliToken(token, origin, now + CLI_TOKEN_TTL_MS)).toBeNull();
    expect(expires_at).toBe(new Date(now + CLI_TOKEN_TTL_MS).toISOString());
  });
  it("does not allow reuse on another installation even with the same encryption key", () => {
    const { token } = issueCliToken(sid, origin, now);
    expect(readCliToken(token, "https://other.example", now)).toBeNull();
  });
  it("rejects tampered ciphertext and authentication tags", () => {
    const { token } = issueCliToken(sid, origin, now);
    for (const index of [0, 12, 35]) {
      const data = Buffer.from(token.slice(8), "base64url");
      data[index] ^= 1;
      expect(readCliToken("kbp_cli_" + data.toString("base64url"), origin, now)).toBeNull();
    }
  });
  it("invalidates credentials on key rotation", () => {
    const { token } = issueCliToken(sid, origin, now);
    vi.stubEnv("APP_ENCRYPTION_KEY_B64", Buffer.alloc(32, 8).toString("base64"));
    expect(readCliToken(token, origin, now)).toBeNull();
  });
  it.each([sid, "Bearer nope", "kbp_cli_", "kbp_cli_" + "a".repeat(1025)])("rejects malformed credentials", token => {
    expect(readCliToken(token, origin, now)).toBeNull();
  });
});
