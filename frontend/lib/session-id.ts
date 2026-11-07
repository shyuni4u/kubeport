// sessions.id is a Postgres uuid. A cookie holding anything else can never
// match a row, and passing it to the query throws 22P02 rather than finding
// nothing — every page then 500s and logout fails too (#487). So the shape
// is checked before the DB: not a UUID means no session. The CLI credential
// and the proxy's login guard use the same rule.
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}
