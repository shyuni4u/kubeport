// Maps a failed template save/create response to an admin-readable sentence.
// The backend detail is kept for 400 (it's the YAML / ui-spec validation
// message the author needs) and for the generic fallback; 409 and 403 get a
// portal-concept explanation instead of a raw JSON body.
//
// `t` is a `useTranslations("templates.editor")` instance.
type Translator = (key: string, values?: Record<string, string | number>) => string;

export async function saveErrorMessage(t: Translator, res: Response): Promise<string> {
  const detail = (await res.text().catch(() => "")).trim();
  switch (res.status) {
    case 409:
      return t("errors.draftExists");
    case 403:
      return t("errors.forbidden");
    case 400:
      return t("errors.invalid", { detail });
    case 429:
      // The authoring routes are rate limited (issue #135), so this is
      // reachable on a real save. Without a case here it fell through to
      // `generic`, which prints the status and the Problem document — and
      // the one thing the author needs to know is that waiting fixes it.
      return t("errors.rateLimited");
    default:
      return t("errors.generic", { status: res.status, detail });
  }
}
