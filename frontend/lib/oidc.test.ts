import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProvider, demoEnabled, providerEnv } from "./oidc";

describe("oidc providers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("parseProvider defaults to primary", () => {
    expect(parseProvider("demo")).toBe("demo");
    expect(parseProvider("primary")).toBe("primary");
    expect(parseProvider("google")).toBe("primary");
    expect(parseProvider(null)).toBe("primary");
  });

  it("demoEnabled requires all three demo env vars", () => {
    vi.stubEnv("DEMO_OIDC_ISSUER", "https://dex.example");
    vi.stubEnv("DEMO_OIDC_CLIENT_ID", "kubeport-demo");
    vi.stubEnv("DEMO_OIDC_CLIENT_SECRET", "");
    expect(demoEnabled()).toBe(false);
    vi.stubEnv("DEMO_OIDC_CLIENT_SECRET", "s");
    expect(demoEnabled()).toBe(true);
  });

  it("providerEnv maps demo to DEMO_* and primary to OIDC_*", () => {
    vi.stubEnv("OIDC_ISSUER", "https://accounts.google.com");
    vi.stubEnv("OIDC_CLIENT_ID", "g");
    vi.stubEnv("OIDC_CLIENT_SECRET", "gs");
    vi.stubEnv("DEMO_OIDC_ISSUER", "https://dex.example");
    vi.stubEnv("DEMO_OIDC_CLIENT_ID", "kubeport-demo");
    vi.stubEnv("DEMO_OIDC_CLIENT_SECRET", "ds");
    expect(providerEnv("primary").issuer).toBe("https://accounts.google.com");
    expect(providerEnv("demo").clientId).toBe("kubeport-demo");
    expect(providerEnv("demo").scopes).toBe("openid email profile");
  });
});
