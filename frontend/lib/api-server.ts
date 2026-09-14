import { serverApiUrl } from "./api-path";
import { getSession, getValidToken } from "./session";

/**
 * Fetch from the Go API in server components.
 * Injects the user's id_token as Bearer token, refreshing if needed.
 * Returns the Response — callers are responsible for handling 401.
 *
 * A path that would not be requested as itself under `/v1/` is refused before
 * the session is read (#374): the answer is a 404 `not-found` Problem, which
 * every caller already turns into notFound() or its inline error.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = process.env.GO_API_BASE_URL;
  if (!base) throw new Error("GO_API_BASE_URL is not set");
  const url = serverApiUrl(base, path);
  if (url === null) {
    console.error(`[apiFetch] refused a path that leaves its own /v1 route: ${JSON.stringify(path)}`);
    return Response.json(
      { type: "https://kubeport.io/errors/not-found", title: "not-found", status: 404, detail: "not found" },
      { status: 404 },
    );
  }

  const session = await getSession();
  const token = session ? await getValidToken(session) : null;

  return fetch(url, {
    cache: "no-store",
    ...init,
    headers: {
      ...init?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
