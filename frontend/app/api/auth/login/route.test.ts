import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn() }) }));
vi.mock("@/lib/oidc", () => ({
  parseProvider: (p: string) => p === "demo" ? "demo" : "primary",
  demoEnabled: () => true,
  getConfig: async () => ({}),
  providerEnv: () => ({ scopes: "openid email profile" }),
  client: {
    randomState: () => "state",
    randomNonce: () => "nonce",
    randomPKCECodeVerifier: () => "verifier",
    calculatePKCECodeChallenge: async () => "challenge",
    buildAuthorizationUrl: (_: unknown, params: Record<string, string>) =>
      new URL(`https://dex.example/auth?${new URLSearchParams(params)}`),
  },
}));

import { GET } from "./route";

describe("demo login prefill", () => {
  it.each(["demo-admin@demo.kubeport", "demo-user@demo.kubeport", "demo+custom@example.com"])(
    "carries %s through provider redirects without changing PKCE",
    async (hint) => {
      const response = await GET(new NextRequest(`https://app.example/api/auth/login?provider=demo&hint=${encodeURIComponent(hint)}`));
      const url = new URL(response.headers.get("location")!);
      expect(new URLSearchParams(url.hash.slice(1)).get("login_hint")).toBe(hint);
      expect(url.searchParams.get("login_hint")).toBe(hint);
      expect(url.searchParams.get("code_challenge")).toBe("challenge");
      expect(url.searchParams.get("state")).toBe("state");
    },
  );

  it("does not send the hint to the primary provider", async () => {
    const response = await GET(new NextRequest("https://app.example/api/auth/login?hint=demo-user%40demo.kubeport"));
    const url = new URL(response.headers.get("location")!);
    expect(url.hash).toBe("");
    expect(url.searchParams.has("login_hint")).toBe(false);
  });
});
