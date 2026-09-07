import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getConfig, client, parseProvider, providerEnv, demoEnabled } from "@/lib/oidc";

export async function GET(req: NextRequest) {
  const provider = parseProvider(req.nextUrl.searchParams.get("provider"));
  if (provider === "demo" && !demoEnabled()) {
    return new NextResponse("demo login is not enabled", { status: 404 });
  }
  const config = await getConfig(provider);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);

  const cookieStore = await cookies();
  cookieStore.set("kbp_oidc_state", JSON.stringify({ state, nonce, verifier, provider }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  const params: Record<string, string> = {
    redirect_uri: process.env.OIDC_REDIRECT_URI!,
    scope: providerEnv(provider).scopes,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  // Dex pre-fills its login form from login_hint; only pass it for the demo
  // provider so we never leak a hint to the primary IdP.
  const hint = req.nextUrl.searchParams.get("hint");
  if (provider === "demo" && hint) params.login_hint = hint;

  const url = client.buildAuthorizationUrl(config, params);
  return NextResponse.redirect(url.href);
}
