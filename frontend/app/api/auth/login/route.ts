import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getConfig, client } from "@/lib/oidc";

export async function GET() {
  const config = await getConfig();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);

  const cookieStore = await cookies();
  cookieStore.set(
    "kbp_oidc_state",
    JSON.stringify({ state, nonce, verifier }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    },
  );

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: process.env.OIDC_REDIRECT_URI!,
    // Google OIDC rejects the `groups` scope with invalid_scope; it is only
    // meaningful for group-aware IdPs (Dex/Keycloak). Default to the standard
    // OIDC scopes and let group-capable deployments opt back in via OIDC_SCOPES.
    scope: process.env.OIDC_SCOPES || "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return NextResponse.redirect(url.href);
}
