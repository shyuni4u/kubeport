import { NextRequest, NextResponse } from "next/server";
import { requestIdFor, upstreamUrl } from "@/lib/bff-path";
import { bffProblem } from "@/lib/bff-problem";
import { getSession, getValidToken } from "@/lib/session";

const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
]);

function filterUpstreamHeaders(upstream: Response): Headers {
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const requestId = requestIdFor(req.headers);
  let session: Awaited<ReturnType<typeof getSession>>;
  let token: string | null;
  try {
    session = await getSession();
    token = session ? await getValidToken(session) : null;
  } catch (e) {
    // getSession reads the sessions table. If Postgres is unreachable this
    // threw out of the handler and Next answered its own 500 — no Problem, no
    // X-Request-Id — which is the one response docs/machine-clients.md's
    // "four responses the BFF answers itself" table does not cover.
    console.error(`bff session id=${requestId}:`, e);
    return bffProblem("internal", 500, "could not read the session", requestId);
  }
  if (!token) {
    return bffProblem("unauthenticated", 401, "no session cookie", requestId);
  }

  const { path } = await params;
  const url = upstreamUrl(process.env.GO_API_BASE_URL ?? "", path, req.nextUrl.search);
  if (!url) {
    return bffProblem("validation-error", 400, "malformed request path", requestId);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    // Without this the backend mints its own id and the caller's trace stops
    // at the BFF — which is exactly what the backend's requestID middleware
    // says it is honouring.
    "X-Request-Id": requestId,
  };
  const ct = req.headers.get("content-type");
  if (ct) headers["Content-Type"] = ct;
  // SSE's resume mechanism. The browser stores the `id:` of the last frame it
  // saw and sends it back here on its automatic reconnect; the backend turns it
  // into a SinceTime so the container log is not replayed from the top into a
  // pane that is never cleared (#107).
  //
  // Named one at a time on purpose — this object is an allowlist, not a
  // passthrough, and the reason is Cookie: the session lives in one and the
  // backend must only ever see the bearer token minted above.
  //
  // GET only. An allowlist entry should be no wider than whatever reads it, and
  // the only reader is the log stream, which EventSource always opens with GET.
  // This handler serves every method on every /v1 path, so without the check a
  // browser-controlled value would reach endpoints that have no use for it.
  const lastEventId = req.headers.get("last-event-id");
  if (req.method === "GET" && lastEventId) headers["Last-Event-ID"] = lastEventId;

  // Forward req.signal so browser disconnect (EventSource close, tab nav)
  // cancels the upstream fetch — critical for SSE endpoints which would
  // otherwise leak a per-pod goroutine in the Go backend on each disconnect.
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.text(),
      signal: req.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      // 499 is nginx's non-standard "client closed request" and has no body,
      // so the id can only travel as a header.
      return new NextResponse(null, { status: 499, headers: { "X-Request-Id": requestId } });
    }
    // Anything else here is the Go API being unreachable — refused, DNS
    // failure, timeout. Rethrowing handed the caller Next's own 500: HTML, no
    // Problem, no request id. "The backend is down" is the most ordinary
    // failure an agent meets, and it was the one that escaped the schema.
    //
    // `internal`, not a new kind: the ErrorKind enum is guarded in both
    // directions against the Go handlers, so a kind only the BFF emits would
    // fail openapi_spec_test.go as "listed but never emitted". 502 rather than
    // 500 because the failure is one hop away, and from the caller's side
    // kubeport is what did not answer either way.
    console.error(`bff proxy id=${requestId}:`, e);
    return bffProblem("internal", 502, "the kubeport API did not answer", requestId);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: filterUpstreamHeaders(upstream),
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
