import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchStorageOnDelete, releaseStorage } from "./release-storage";

describe("releaseStorage (#340)", () => {
  it("passes the verdicts the API documents", () => {
    expect(releaseStorage("deleted")).toBe("deleted");
    expect(releaseStorage("kept")).toBe("kept");
    expect(releaseStorage("none")).toBe("none");
    expect(releaseStorage("unknown")).toBe("unknown");
  });

  it("reads anything else as unknown, which warns the storage may go", () => {
    expect(releaseStorage(undefined)).toBe("unknown");
    expect(releaseStorage(null)).toBe("unknown");
    expect(releaseStorage("")).toBe("unknown");
    expect(releaseStorage("Deleted")).toBe("unknown");
    expect(releaseStorage(true)).toBe("unknown");
  });
});

describe("fetchStorageOnDelete (#340)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the verdict with the opt-in query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ storage_on_delete: "deleted" })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchStorageOnDelete("rel-1")).resolves.toBe("deleted");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/releases/rel-1?include=storage_on_delete");
  });

  it("is unknown when the request fails, the body is not JSON, or the field is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 502 })));
    await expect(fetchStorageOnDelete("rel-1")).resolves.toBe("unknown");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>")));
    await expect(fetchStorageOnDelete("rel-1")).resolves.toBe("unknown");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "healthy" }))));
    await expect(fetchStorageOnDelete("rel-1")).resolves.toBe("unknown");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(fetchStorageOnDelete("rel-1")).resolves.toBe("unknown");
  });
});
