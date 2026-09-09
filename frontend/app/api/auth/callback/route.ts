import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getConfig, client, parseProvider } from "@/lib/oidc";
import { createSession } from "@/lib/session";
import { externalOrigin } from "@/lib/request-origin";
import { loginErrorFromIdp, type LoginErrorCode } from "@/lib/login-error";
import { pool } from "@/lib/db";

/**
 * Send the user back to the landing page with a code it can explain, and drop
 * the one-shot state cookie so the next attempt starts clean.
 *
 * Everything that can go wrong here is either the user's choice (cancelled at
 * the consent screen), time passing (the 10-minute state cookie expired), or
 * an outage. None of those should surface as a 500 on a blank page with no way
 * back — and a route-handler throw isn't caught by app/error.tsx anyway.
 */
async function backToLanding(req: NextRequest, code: LoginErrorCode) {
  (await cookies()).delete("kbp_oidc_state");
  return NextResponse.redirect(new URL(`/?login_error=${code}`, externalOrigin(req)));
}

export async function GET(req: NextRequest) {
  // The IdP reports refusals in the query string, not by failing the redirect.
  const idpError = req.nextUrl.searchParams.get("error");
  if (idpError) {
    // Attacker-controlled and pre-authentication: quote and truncate it so a
    // newline can't forge a log line or a long value flood the log.
    console.warn("[auth/callback] idp returned error=%s", JSON.stringify(idpError.slice(0, 64)));
    return backToLanding(req, loginErrorFromIdp(idpError));
  }

  const cookieStore = await cookies();
  const raw = cookieStore.get("kbp_oidc_state")?.value;
  // No state cookie: either the 10-minute window elapsed with the login form
  // open, or this callback was reached without going through /api/auth/login.
  if (!raw) return backToLanding(req, "expired");

  let parsed: { state: string; nonce: string; verifier: string; provider?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return backToLanding(req, "expired");
  }
  const { state, nonce, verifier } = parsed;
  const provider = parseProvider(parsed.provider);

  try {
    const config = await getConfig(provider);

    // Behind the proxy req.url resolves to the internal bind host
    // (http://0.0.0.0:3000/...); openid-client derives the token-exchange
    // redirect_uri from the URL we pass, and Google rejects a mismatch. Build the
    // current URL from OIDC_REDIRECT_URI — the exact value used at /login and
    // registered in the OAuth client — so the token redirect_uri matches byte for
    // byte. Fall back to the public origin if the env is unset.
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
      console.error("[auth/callback] token response had no id_token or claims");
      return backToLanding(req, "failed");
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
  } catch (err) {
    // Expired/replayed code, state or nonce mismatch, IdP or Postgres
    // unreachable. The detail is for the server log only — but a state or
    // nonce mismatch means someone replayed or forged a callback, which is
    // worth alerting on, and it must not read the same as an outage.
    const message = String((err as Error)?.message ?? "");
    console.error(
      "[auth/callback] login failed kind=%s suspicious=%s",
      (err as Error)?.constructor?.name ?? "Error",
      /state|nonce/i.test(message),
      err,
    );
    return backToLanding(req, "failed");
  }

  cookieStore.delete("kbp_oidc_state");
  return NextResponse.redirect(new URL("/catalog", externalOrigin(req)));
}
