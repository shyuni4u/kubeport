import { NextRequest, NextResponse } from "next/server";
import { requestIdFor, upstreamUrl } from "@/lib/bff-path";
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

/** A Problem the BFF answers itself, carrying the same id as the log. */
function bffProblem(kind: string, status: number, detail: string, requestId: string) {
  return NextResponse.json(
    {
      type: `https://kubeport.io/errors/${kind}`,
      title: kind,
      status,
      detail,
      request_id: requestId,
    },
    { status, headers: { "X-Request-Id": requestId } },
  );
}

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const requestId = requestIdFor(req.headers);
  const session = await getSession();
  const token = session ? await getValidToken(session) : null;
  if (!token) {
    // Same shape as the Go API's Problem (backend/internal/api/errors.go), so
    // a client parses one schema across the whole /api/v1 surface (#56).
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
    throw e;
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: filterUpstreamHeaders(upstream),
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
