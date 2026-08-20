import { cookies } from "next/headers";
import { pool } from "./db";
import { getConfig, client } from "./oidc";
import crypto from "node:crypto";

const COOKIE = "kbp_sid";

export interface Session {
  id: string;
  userId: string;
  idToken: string;
  refreshToken?: string;
  idTokenExp: Date;
}

function getKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY_B64;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY_B64 is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `APP_ENCRYPTION_KEY_B64 must decode to 32 bytes (got ${key.length})`,
    );
  }
  return key;
}

function encrypt(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

function decrypt(b64: string): string {
  const key = getKey();
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
    "utf8",
  );
}

export async function createSession(
  userId: string,
  idToken: string,
  refreshToken: string | undefined,
  exp: Date,
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  await pool.query(
    `INSERT INTO sessions (id, user_id, id_token_encrypted, refresh_token_encrypted, id_token_exp, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      userId,
      encrypt(idToken),
      refreshToken ? encrypt(refreshToken) : null,
      exp,
      expiresAt,
    ],
  );
  const cookieStore = await cookies();
  cookieStore.set(COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const id = cookieStore.get(COOKIE)?.value;
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT id, user_id, id_token_encrypted, refresh_token_encrypted, id_token_exp
       FROM sessions WHERE id=$1 AND expires_at > now()`,
    [id],
  );
  if (!rows[0]) return null;
  try {
    return {
      id: rows[0].id,
      userId: rows[0].user_id,
      idToken: decrypt(rows[0].id_token_encrypted),
      refreshToken: rows[0].refresh_token_encrypted
        ? decrypt(rows[0].refresh_token_encrypted)
        : undefined,
      idTokenExp: rows[0].id_token_exp,
    };
  } catch {
    // Tampered or key-rotated session — treat as invalid and force re-login.
    // DB delete is authoritative; the stale cookie will be rejected on next load.
    // (cookieStore.delete is readonly in Server Components, so we skip it here.)
    await pool.query("DELETE FROM sessions WHERE id=$1", [id]);
    return null;
  }
}

export async function updateSessionTokens(
  sessionId: string,
  idToken: string,
  refreshToken: string | undefined,
  exp: Date,
) {
  await pool.query(
    `UPDATE sessions SET id_token_encrypted=$1, refresh_token_encrypted=$2, id_token_exp=$3
     WHERE id=$4`,
    [
      encrypt(idToken),
      refreshToken ? encrypt(refreshToken) : null,
      exp,
      sessionId,
    ],
  );
}

export async function destroySession() {
  const cookieStore = await cookies();
  const id = cookieStore.get(COOKIE)?.value;
  if (id) await pool.query("DELETE FROM sessions WHERE id=$1", [id]);
  cookieStore.delete(COOKIE);
}

/**
 * Returns a valid id_token for the session, refreshing if it's within 60s of expiring.
 * Returns null if the session is already expired and refresh fails — caller should 401.
 */
export async function getValidToken(
  session: Session,
): Promise<string | null> {
  if (session.idTokenExp.getTime() > Date.now() + 60_000) {
    return session.idToken;
  }
  if (!session.refreshToken) return null;

  try {
    const config = await getConfig();
    const tokens = await client.refreshTokenGrant(config, session.refreshToken);
    if (!tokens.id_token) return null;

    const exp = tokens.expiresIn()
      ? new Date(Date.now() + tokens.expiresIn()! * 1000)
      : new Date(Date.now() + 3600 * 1000);

    await updateSessionTokens(
      session.id,
      tokens.id_token,
      tokens.refresh_token ?? session.refreshToken,
      exp,
    );
    return tokens.id_token;
  } catch {
    await pool.query("DELETE FROM sessions WHERE id=$1", [session.id]);
    return null;
  }
}
