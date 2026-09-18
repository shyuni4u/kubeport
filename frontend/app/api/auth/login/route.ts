import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getConfig, client, parseProvider, providerEnv, demoEnabled } from "@/lib/oidc";
import { sanitizeNext } from "@/lib/safe-next";
import { AUTH_COOKIE_ATTRS, OIDC_STATE_COOKIE } from "@/lib/cookie-names";

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
  cookieStore.set(OIDC_STATE_COOKIE, JSON.stringify({ state, nonce, verifier, provider, next }), {
    ...AUTH_COOKIE_ATTRS,
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
  // Keep the standard hint for providers that support it. Dex's local
  // connector uses our password template and the redirect-preserved fragment.
  const hint = req.nextUrl.searchParams.get("hint");
  if (provider === "demo" && hint) params.login_hint = hint;

  const url = client.buildAuthorizationUrl(config, params);
  if (provider === "demo" && hint) {
    url.hash = new URLSearchParams({ login_hint: hint }).toString();
  }
  return NextResponse.redirect(url.href);
}
