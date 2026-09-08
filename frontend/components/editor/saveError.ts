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
    default:
      return t("errors.generic", { status: res.status, detail });
  }
}
