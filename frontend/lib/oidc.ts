import * as client from "openid-client";

let cached: client.Configuration | null = null;

export async function getConfig(): Promise<client.Configuration> {
  if (cached) return cached;

  const issuerUrl = new URL(process.env.OIDC_ISSUER!);
  const opts: Parameters<typeof client.discovery>[4] =
    process.env.NODE_ENV !== "production"
      ? { execute: [client.allowInsecureRequests] }
      : undefined;

  cached = await client.discovery(
    issuerUrl,
    process.env.OIDC_CLIENT_ID!,
    process.env.OIDC_CLIENT_SECRET!,
    undefined,
    opts,
  );
  return cached;
}

export {
  client,
};
