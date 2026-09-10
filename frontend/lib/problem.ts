/**
 * The `title` of a Problem response body, or undefined when the body is not a
 * Problem.
 *
 * `title` is the closed ErrorKind vocabulary the API branches on
 * (backend/api/openapi.yaml, docs/machine-clients.md) — the status alone does
 * not say why a request was refused. A 403 is both "your role cannot do this"
 * and `demo-restricted`, and the sentence and what the reader can do about it
 * differ (#180).
 *
 * Takes the body text rather than the Response so callers that already read it
 * (for logging, or to keep a 400's detail) do not have to read it twice.
 */
export function problemTitle(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "title" in parsed) {
      const title = (parsed as { title: unknown }).title;
      return typeof title === "string" && title !== "" ? title : undefined;
    }
  } catch {
    // Not JSON — an HTML error page from a proxy, or an empty body.
  }
  return undefined;
}
