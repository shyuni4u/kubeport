import * as client from "openid-client";

export type Provider = "primary" | "demo";

export function parseProvider(v: string | null | undefined): Provider {
  return v === "demo" ? "demo" : "primary";
}

export function demoEnabled(): boolean {
  return Boolean(
    process.env.DEMO_OIDC_ISSUER &&
      process.env.DEMO_OIDC_CLIENT_ID &&
      process.env.DEMO_OIDC_CLIENT_SECRET,
  );
}

export function providerEnv(p: Provider): {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
} {
  if (p === "demo") {
    return {
      issuer: process.env.DEMO_OIDC_ISSUER!,
      clientId: process.env.DEMO_OIDC_CLIENT_ID!,
      clientSecret: process.env.DEMO_OIDC_CLIENT_SECRET!,
      scopes: process.env.DEMO_OIDC_SCOPES || "openid email profile",
    };
  }
  return {
    issuer: process.env.OIDC_ISSUER!,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET!,
    scopes: process.env.OIDC_SCOPES || "openid email profile",
  };
}

const cached: Partial<Record<Provider, client.Configuration>> = {};

export async function getConfig(
  provider: Provider = "primary",
): Promise<client.Configuration> {
  const hit = cached[provider];
  if (hit) return hit;
  if (provider === "demo" && !demoEnabled()) {
    throw new Error("demo provider requested but DEMO_OIDC_* env is not set");
  }
  const env = providerEnv(provider);
  const opts: Parameters<typeof client.discovery>[4] =
    process.env.NODE_ENV !== "production"
      ? { execute: [client.allowInsecureRequests] }
      : undefined;

  const cfg = await client.discovery(
    new URL(env.issuer),
    env.clientId,
    env.clientSecret,
    undefined,
    opts,
  );
  cached[provider] = cfg;
  return cfg;
}

export {
  client,
};
