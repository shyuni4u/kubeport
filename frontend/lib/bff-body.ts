/**
 * Request body cap for the BFF, the same 4 MiB the Go backend enforces
 * (`maxRequestBody` in backend/internal/api/ratelimit.go). Keep them in step.
 *
 * The backend's cap alone does not protect the BFF: the proxy used to read the
 * whole body with `req.text()` before forwarding, so a body of hundreds of MB
 * was held in the frontend pod's memory (512Mi on the live demo, whose
 * password is on the landing page) before the backend ever saw a byte of it.
 * `proxy.ts` skips `api/`, so Next's own proxy body limit does not apply here
 * either.
 */
export const MAX_REQUEST_BODY = 4 << 20;

export const PAYLOAD_TOO_LARGE_DETAIL = "request body exceeds 4 MiB";

/**
 * Reads a request body, refusing it once it is known to exceed `max` bytes:
 * up front when `Content-Length` says so, otherwise the moment the running
 * count passes it — so at most `max` bytes plus one chunk are ever held.
 * A body of exactly `max` bytes is accepted, matching http.MaxBytesReader.
 */
export async function readBoundedBody(
  req: Pick<Request, "headers" | "body">,
  max: number = MAX_REQUEST_BODY,
): Promise<Uint8Array<ArrayBuffer> | "too-large"> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return "too-large";
  if (!req.body) return new Uint8Array(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
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
