/**
 * Request body cap for the BFF, the same 4 MiB the Go backend enforces
 * (`maxRequestBody` in backend/internal/api/ratelimit.go). Keep them in step.
 *
 * The backend's cap alone does not protect the BFF: the proxy used to read the
 * whole body with `req.text()` before forwarding, so a body of hundreds of MB
 * was held in the frontend pod's memory (512Mi on the live demo, whose
 * password is on the landing page) before the backend ever saw a byte of it.
 * `proxy.ts` does not match an `api/` request that carries a body, so Next never
 * clones one ahead of this handler and its own proxy body limit does not apply
 * here either — the cap below, after the session check, is the only read.
 */
export const MAX_REQUEST_BODY = 4 << 20;

export const PAYLOAD_TOO_LARGE_DETAIL = "request body exceeds 4 MiB";

/**
 * Reads a request body, refusing it once it is known to exceed `max` bytes:
 * up front when `Content-Length` says so, otherwise the moment the running
 * count passes it. A body of exactly `max` bytes is accepted, matching
 * http.MaxBytesReader.
 *
 * Memory held per request: with a `Content-Length` (what browsers and fetch
 * send) the buffer is allocated once at that size and chunks are copied
 * straight in, so at most `max` bytes. A body of unknown length is collected
 * in chunks and joined at the end, so up to 2×`max` transiently.
 */
export async function readBoundedBody(
  req: Pick<Request, "headers" | "body">,
  max: number = MAX_REQUEST_BODY,
): Promise<Uint8Array<ArrayBuffer> | "too-large"> {
  const header = req.headers.get("content-length");
  const declared = header === null ? NaN : Number(header);
  if (Number.isFinite(declared) && declared > max) return "too-large";
  if (!req.body) return new Uint8Array(0);

  const reader = req.body.getReader();
  const refuse = async () => {
    await reader.cancel().catch(() => {});
    return "too-large" as const;
  };

  if (Number.isInteger(declared) && declared >= 0) {
    // Node's parser hands over exactly Content-Length bytes, so a body longer
    // than it declared does not reach here; if one ever did, it is refused
    // rather than trusted past the buffer.
    const out = new Uint8Array(declared);
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > declared) return refuse();
      out.set(value, offset);
      offset += value.byteLength;
    }
    return offset === declared ? out : out.slice(0, offset);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) return refuse();
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
