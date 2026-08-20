import { getSession, getValidToken } from "./session";

/**
 * Fetch from the Go API in server components.
 * Injects the user's id_token as Bearer token, refreshing if needed.
 * Returns the Response — callers are responsible for handling 401.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const session = await getSession();
  const token = session ? await getValidToken(session) : null;

  const url = `${process.env.GO_API_BASE_URL}${path}`;
  return fetch(url, {
    cache: "no-store",
    ...init,
    headers: {
      ...init?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
