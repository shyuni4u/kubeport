import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getConfig, client, parseProvider, providerEnv, demoEnabled } from "@/lib/oidc";
import { sanitizeNext } from "@/lib/safe-next";

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

  // Carried in the state cookie rather than through the IdP round trip: the
  // cookie is httpOnly, one-shot and already the thing the callback trusts,
  // so `next` gets the same handling as the nonce instead of riding back on a
  // query string the user can edit between the two hops. Sanitized on the way
  // in AND on the way out — this is a redirect target, and a stale cookie from
  // an older deploy is not something the callback should have to trust.
  const next = sanitizeNext(req.nextUrl.searchParams.get("next"));

  const cookieStore = await cookies();
  cookieStore.set("kbp_oidc_state", JSON.stringify({ state, nonce, verifier, provider, next }), {
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
  // login_hint goes to the demo provider only, so a hint never leaks to the
  // primary IdP. Dex's local connector currently ignores it — the login form
  // opens empty — so the landing page shows each demo account's email under
  // its button instead (#29). Kept because it costs nothing and an IdP that
  // honours it would pre-fill.
  const hint = req.nextUrl.searchParams.get("hint");
  if (provider === "demo" && hint) params.login_hint = hint;

  const url = client.buildAuthorizationUrl(config, params);
  return NextResponse.redirect(url.href);
}
