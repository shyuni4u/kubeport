import { NextRequest, NextResponse } from "next/server";
import { upstreamUrl } from "@/lib/bff-path";
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
  const session = await getSession();
  const token = session ? await getValidToken(session) : null;
  if (!token) {
    // Same shape as the Go API's Problem (backend/internal/api/errors.go), so
    // a client parses one schema across the whole /api/v1 surface (#56).
    return NextResponse.json(
      {
        type: "https://kubeport.io/errors/unauthenticated",
        title: "unauthenticated",
        status: 401,
        detail: "no session cookie",
      },
      { status: 401 },
    );
  }

  const { path } = await params;
  const url = upstreamUrl(process.env.GO_API_BASE_URL ?? "", path, req.nextUrl.search);
  if (!url) {
    return NextResponse.json(
      {
        type: "https://kubeport.io/errors/validation-error",
        title: "validation-error",
        status: 400,
        detail: "malformed request path",
      },
      { status: 400 },
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
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
      return new NextResponse(null, { status: 499 });
    }
    throw e;
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: filterUpstreamHeaders(upstream),
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
