import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getConfig, client, parseProvider } from "@/lib/oidc";
import { createSession } from "@/lib/session";
import { externalOrigin } from "@/lib/request-origin";
import { pool } from "@/lib/db";

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const raw = cookieStore.get("kbp_oidc_state")?.value;
  if (!raw) return new NextResponse("missing state", { status: 400 });

  let parsed: { state: string; nonce: string; verifier: string; provider?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new NextResponse("invalid state", { status: 400 });
  }
  const { state, nonce, verifier } = parsed;
  const provider = parseProvider(parsed.provider);

  const config = await getConfig(provider);

  // Behind the proxy req.url resolves to the internal bind host
  // (http://0.0.0.0:3000/...); openid-client derives the token-exchange
  // redirect_uri from the URL we pass, and Google rejects a mismatch. Build the
  // current URL from OIDC_REDIRECT_URI — the exact value used at /login and
  // registered in the OAuth client — so the token redirect_uri matches byte for
  // byte. Fall back to the forwarded origin if the env is unset.
  const incoming = new URL(req.url);
  const base = process.env.OIDC_REDIRECT_URI ?? `${externalOrigin(req)}/api/auth/callback`;
  const currentUrl = new URL(base);
  currentUrl.search = incoming.search;
  console.log(
    `[auth/callback] token exchange redirect_uri=${currentUrl.origin}${currentUrl.pathname} (OIDC_REDIRECT_URI=${process.env.OIDC_REDIRECT_URI})`,
  );

  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: verifier,
    expectedState: state,
    expectedNonce: nonce,
  });

  const claims = tokens.claims();
  if (!claims || !tokens.id_token) {
    return new NextResponse("missing id_token or claims", { status: 400 });
  }

  const { rows } = await pool.query(
    `INSERT INTO users (oidc_subject, email, display_name)
       VALUES ($1,$2,$3)
     ON CONFLICT (oidc_subject) DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name, last_seen_at=now()
     RETURNING id`,
    [claims.sub, claims.email ?? null, claims.name ?? null],
  );
  const userId = rows[0].id;

  const expiresAt = tokens.expiresIn()
    ? new Date(Date.now() + tokens.expiresIn()! * 1000)
    : new Date(Date.now() + 3600 * 1000);

  await createSession(userId, tokens.id_token, tokens.refresh_token, expiresAt, provider);
  cookieStore.delete("kbp_oidc_state");
  return NextResponse.redirect(new URL("/catalog", externalOrigin(req)));
}
