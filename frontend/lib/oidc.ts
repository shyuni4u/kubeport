import * as client from "openid-client";

import { demoConfigured } from "./demo-config";

export type Provider = "primary" | "demo";

export function parseProvider(v: string | null | undefined): Provider {
  return v === "demo" ? "demo" : "primary";
}

// Lives in its own import-free module so the proxy can use the same check
// without pulling openid-client in with it. Re-exported under the old name
// because this is where every existing caller looks for it.
export const demoEnabled = demoConfigured;

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
