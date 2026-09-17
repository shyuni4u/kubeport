import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Separate key/purpose from encrypted OIDC tokens. In particular, the session
// ID itself is a browser credential and must never be exposed in a signed JWT.
const PURPOSE = Buffer.from("kubeport/cli-session/v1");
export const CLI_TOKEN_TTL_MS = 60 * 60 * 1000;
const PREFIX = "kbp_cli_";

function key(): Buffer {
  const root = Buffer.from(process.env.APP_ENCRYPTION_KEY_B64 ?? "", "base64");
  if (root.length !== 32) throw new Error("APP_ENCRYPTION_KEY_B64 must decode to 32 bytes");
  return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), PURPOSE, 32));
}

export function issueCliToken(sessionId: string, origin: string, now = Date.now()) {
  const expiresAt = now + CLI_TOKEN_TTL_MS;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(PURPOSE);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ sessionId, origin, expiresAt }), "utf8"), cipher.final(),
  ]);
  return {
    token: PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url"),
    expires_at: new Date(expiresAt).toISOString(),
  };
}

export function readCliToken(token: string, origin: string, now = Date.now()): string | null {
  if (!/^kbp_cli_[A-Za-z0-9_-]{40,1024}$/.test(token)) return null;
  // Configuration failures are server failures, not bad credentials.
  const secret = key();
  try {
    const data = Buffer.from(token.slice(PREFIX.length), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", secret, data.subarray(0, 12));
    decipher.setAAD(PURPOSE);
    decipher.setAuthTag(data.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([
      decipher.update(data.subarray(28)), decipher.final(),
    ]).toString("utf8"));
    if (payload.origin !== origin || !Number.isSafeInteger(payload.expiresAt) ||
        payload.expiresAt <= now || payload.expiresAt > now + CLI_TOKEN_TTL_MS ||
        typeof payload.sessionId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(payload.sessionId)) return null;
    return payload.sessionId;
  } catch {
    return null;
  }
}
