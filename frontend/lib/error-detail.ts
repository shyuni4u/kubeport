/**
 * How much of a refused request a screen shows (#6).
 *
 * The API already decides what a caller may read: a Problem's `detail` carries
 * the apiserver's verdict or a validation sentence, and what must not reach a
 * browser — a 500's cause (#49), a cluster's address (#52), client-go's text on
 * a log stream (#108) — never leaves the server. A level only chooses how much
 * of the body the caller was already sent is unfolded on screen. So no level is
 * a privilege: a viewer who picks "raw" sees what the browser's network tab
 * would show them anyway, without the JSON around it.
 *
 * - friendly: the screen's own sentence, and a copyable block to send an admin
 * - detailed: + the kind, status, structured fields and the server's message,
 *   folded — a 500's detail excepted, which only names the failed operation
 * - raw: every message, unfolded
 *
 * The choice lives in a cookie for the reason theme.ts gives: the server renders
 * the first paint from it, so hydration sees what it was sent. Import-free on
 * purpose: the root layout (server) and the switch (client) both import it.
 */

export const ERROR_DETAIL_COOKIE = "kbp_error_detail";
export const ERROR_DETAIL_LEVELS = ["friendly", "detailed", "raw"] as const;
export type ErrorDetailLevel = (typeof ERROR_DETAIL_LEVELS)[number];

/** A year, like the theme: a UI setting, not a session. */
export const ERROR_DETAIL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function parseErrorDetailLevel(raw: string | null | undefined): ErrorDetailLevel | undefined {
  return (ERROR_DETAIL_LEVELS as readonly string[]).includes(raw ?? "")
    ? (raw as ErrorDetailLevel)
    : undefined;
}

/**
 * Where a viewer starts before choosing. `adminDefault` and `userDefault` are
 * the install's values (chart `frontend.errorDetail.*` → ERROR_DETAIL_ADMIN /
 * ERROR_DETAIL_USER); anything unparseable falls back to the chart defaults.
 *
 * A demo admin starts at "detailed" whatever the install says: the demo is
 * public, and its admin screens are shown to visitors. That is presentation,
 * not a boundary — the demo account receives the same bodies at every level.
 */
export function defaultErrorDetailLevel(opts: {
  role: "admin" | "user";
  demo: boolean;
  adminDefault?: string;
  userDefault?: string;
}): ErrorDetailLevel {
  if (opts.role === "admin" && opts.demo) return "detailed";
  if (opts.role === "admin") return parseErrorDetailLevel(opts.adminDefault) ?? "raw";
  return parseErrorDetailLevel(opts.userDefault) ?? "friendly";
}

/** The viewer's cookie if it names a level, otherwise their starting level. */
export function resolveErrorDetailLevel(
  cookie: string | null | undefined,
  fallback: ErrorDetailLevel,
): ErrorDetailLevel {
  return parseErrorDetailLevel(cookie) ?? fallback;
}

/**
 * The `document.cookie` string the switch writes — the same attributes as the
 * theme cookie, for the reasons given there: host-only (no Domain), Path=/,
 * SameSite=Lax, not HttpOnly, Secure only on an https page.
 */
export function errorDetailCookie(level: ErrorDetailLevel, secure: boolean): string {
  return `${ERROR_DETAIL_COOKIE}=${level}; Path=/; Max-Age=${ERROR_DETAIL_COOKIE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** A Problem body, read for display. Null when the body is not a Problem. */
export type ParsedProblem = {
  title?: string;
  detail?: string;
  requestId?: string;
  /** RFC 7807 extension members (`conflicts`, `pinned_namespace`, …). */
  extensions: Record<string, unknown>;
};

const ENVELOPE = new Set(["type", "title", "status", "detail", "request_id"]);

export function parseProblemBody(body: string | null | undefined): ParsedProblem | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.title !== "string" || o.title === "") return null;
  const extensions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!ENVELOPE.has(k)) extensions[k] = v;
  }
  return {
    title: o.title,
    detail: typeof o.detail === "string" && o.detail !== "" ? o.detail : undefined,
    requestId: typeof o.request_id === "string" && o.request_id !== "" ? o.request_id : undefined,
    extensions,
  };
}

/** What a level unfolds of a refused response. */
export type ProblemParts = {
  /** Show the kind and status. */
  kind: boolean;
  /** The server's message, when this level shows it. */
  detail?: string;
  /** Extension members, when this level shows them and there are any. */
  extensions?: Record<string, unknown>;
  /** Whether the details start open. */
  open: boolean;
};

export function problemParts(
  level: ErrorDetailLevel,
  status: number,
  problem: ParsedProblem | null,
): ProblemParts {
  if (level === "friendly" || !problem) return { kind: false, open: false };
  const extensions = Object.keys(problem.extensions).length > 0 ? problem.extensions : undefined;
  // A 500's detail is "<operation> failed" (#49): the cause is in the server
  // log, and the sentence adds nothing a "detailed" reader can act on.
  const detail = level === "raw" || status !== 500 ? problem.detail : undefined;
  return { kind: true, detail, extensions, open: level === "raw" };
}
