import { describe, expect, it } from "vitest";
import { MAX_REQUEST_BODY, readBoundedBody } from "./bff-body";

/** A request-shaped object whose body arrives in the given chunks. */
function streamed(chunks: number[], headers: Record<string, string> = {}) {
  let pulled = 0;
  let cancelled = false;
  // highWaterMark 0: nothing is pulled until the reader asks, so `pulled`
  // counts exactly the chunks readBoundedBody read.
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      pull(controller) {
        if (pulled === chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunks[pulled++]).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    req: { headers: new Headers(headers), body },
    pulled: () => pulled,
    cancelled: () => cancelled,
  };
}

describe("readBoundedBody", () => {
  it("returns the bytes of a body under the cap", async () => {
    const { req } = streamed([3, 4]);
    const out = await readBoundedBody(req, 10);
    expect(out).toBeInstanceOf(Uint8Array);
    expect((out as Uint8Array).byteLength).toBe(7);
  });

  // http.MaxBytesReader lets exactly max bytes through; the BFF must not refuse
  // what the backend would accept.
  it("accepts a body of exactly the cap", async () => {
    const { req } = streamed([6, 4]);
    expect(((await readBoundedBody(req, 10)) as Uint8Array).byteLength).toBe(10);
  });

  it("refuses a declared Content-Length over the cap without reading", async () => {
    const { req, pulled } = streamed([1], { "content-length": "11" });
    expect(await readBoundedBody(req, 10)).toBe("too-large");
    expect(pulled()).toBe(0);
  });

  // A chunked body has no Content-Length, and a lying one can understate. The
  // count is what bounds memory: reading stops at the chunk that passes the cap.
  it("stops reading once an undeclared body passes the cap", async () => {
    const { req, pulled, cancelled } = streamed([6, 6, 6, 6]);
    expect(await readBoundedBody(req, 10)).toBe("too-large");
    expect(pulled()).toBe(2);
    expect(cancelled()).toBe(true);
  });

  it("fills a declared-length body into one buffer of that size", async () => {
    const { req } = streamed([4, 3], { "content-length": "7" });
    const out = (await readBoundedBody(req, 10)) as Uint8Array;
    expect(out.byteLength).toBe(7);
    expect(out.buffer.byteLength).toBe(7);
  });

  it("does not trust an understated Content-Length", async () => {
    const { req } = streamed([6, 6], { "content-length": "5" });
    expect(await readBoundedBody(req, 10)).toBe("too-large");
  });

  it("treats a missing body as empty", async () => {
    const out = await readBoundedBody({ headers: new Headers(), body: null }, 10);
    expect((out as Uint8Array).byteLength).toBe(0);
  });

  it("defaults to the backend's 4 MiB", () => {
    expect(MAX_REQUEST_BODY).toBe(4 * 1024 * 1024);
  });
});
